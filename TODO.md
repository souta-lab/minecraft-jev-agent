# TODO — AI_Buddy / Minecraft agent（優先順・正典）

> 最終目標: **M4（Ender Dragon 討伐）**。M2（鉄器時代）は通過点。
> 運用: ユーザーの発言を待たない。やることが無ければ自分で仕事を考えて着手する（`AGENTS.md` §0）。
> 更新: 2026-09-18 02:25 JST

## 現在のクリティカルパス
```
1. #15 アドバイザ・キャッシュループの解消（実測: 同一cached戦略が112回連続 → 身体が動かない）
   ★暫定回避済み: buddy-driver/system2.config.json を {"mercury": true} に変更 → 直ちに cached=false の
     Mercury新規呼び出し（ms=4468〜6655 / cost≈$0.00028）と戦略変化を確認（2026-09-18 02:24）
     → 恒久修正は #15（cache hit は plan を再生／同一WAIT再発でキャッシュ無効化／grounding で実行不能戦略を拒否）
2. #12 前提チェーン差し替えの完成（現在 3/6: LADDER_PREREQ=176, churn 2回/5分, listenerLeak=false。
   残: 1tick停止の残存 / digging_resumed / raw_iron_obtained）
3. 掘削再開の確認 → TOOL_CHOICE / DIG_PATH / JUMP_ATTEMPT / DESCEND_LIMIT / STAIRCASE の実効確認（#7/#8/#9）
4. M2 完走: furnace→charcoal→iron_ore→iron_ingot×3→iron_pickaxe を在庫で証明
```

## 前倒しした設計コントラクト（Sol全体レビュー準拠）
```
#21 OptionSpec + PlannedGoal→Option compiler        ← 進行中（branch task/21-optionspec）
#20 Grounded Skill candidates（戦略が身体へ伝わる）#14 既知資源の座標保持 #29 strategy grounding
#22 β shadow（abandon_option を生値で記録）#32 Jev Boolean 生値保持 #36 end-to-end causal IDs
#23 replay A/B harness → #24 β termination controller（authority はデータが揃ってから）
#41 predicate-based Capability / Option Graph（M3/M4 の非itemゴール、precondition は dependency 展開）
```

## 安全・基盤（P1）
```
#13 listener leak（physicsTick 3 vs baseline 2）／#5 lease commit 前の durable write／#28 disconnect時 lease revoke
#27 reconnect storm（reconnects=65）／#25 worldEpoch 切替の世代不整合／#38 allowlist型 leased ActuationPort
#39 resident↔JevController の明示API（private cast 排除）／#40 単一の型付き AgentSnapshot（A mission=HOST transactional,
   B server truth=非永続, C caches=捨てて良い, D logs=証拠のみ）
#16 Mercury cache の world scope／#18 retry accounting／#19 PLACE furnace の schema 表現／#30 patch/replace の tail 保持
#26 simdeath の hazard 誤加算／#31 station memory が add-only／#34 simdeath の lostInventory ログ取得タイミング
#35 semantic planner 三重化の整理（#11 勝利後に統合）
```

## 研究・比較（並行可・コード非依存）
```
#42 ★Minecraftエージェントの先行研究調査（ユーザー依頼）
   Voyager / DEPS / GITM / MP5 / Odyssey / Jarvis-1 / Cradle 等のLLMエージェント、
   VLM系（MineDojo・MineCLIP / VPT / STEVE-1）、ベンチマーク（MineDojo, MineRL BASALT/Diamond）、
   Options階層制御の文献、失敗モード（振動・停止・戦略が身体に伝わらない・キャッシュ/古い計画・
   preconditionデッドロック・無制限降下・死亡/リスポン・次元変更・termination評価）
   成果物: PRIOR-WORK.md（引用付き・アーキ比較表・ロードマップへの含意・既知のデッドエンド警告）
#37 M3/M4 ロードマップ（goal templates + 必要プリミティブ）
```

## 環境・運用の前提（忘れがち）
```
・difficulty=peaceful では敵対mobが出ず blaze_rod / ender_pearl が入手不能 → M3d の前に normal へ切替が必要
  （ops.json に s0u7a と AI_Buddy を level 4 で登録済み。次回再起動後に有効）
・RCONはLeafでは実際にはlistenしない → ops.json 方式で運用
・Java は 21.0.13-ea のため `-DPaper.IgnoreJavaVersion=true` 必須
・常駐ホストは単一インスタンス。検証は node tools/buddy-status.mjs
・ブランチ作業は git worktree（共有ツリーで checkout しない）。ブランチ修正は main マージ後に初めて稼働中エージェントへ反映
・ゲート: tools/verify-issue12.mjs / verify-issue13.mjs / verify-mercury.mjs
```

## 長期方針: 戦闘（peaceful解除）と高速制御（ユーザー指示 2026-09-18）
```
前提: 現状 peaceful だが M3d/M3e（ブレイズ・エンダーマン）以降は敵対mobが必須 → 遅かれ早かれ解除する。
      解除後は「ゆっくりでも攻略は可能」だが、**戦える品質には tick レベルの高速制御が必要**。
```
要件（解除前に設計だけ固めておく）:
```
1. 反応レイヤの分離: LLM/Jev を挟まず 20Hz（tick相当）で動く反射層を用意する
   （被弾→後退/盾、敵接近→攻撃/距離取り、溶岩/落下→回避、クリスタル→射撃）。判断はコード＋閾値。
2. 攻撃・弓・盾・食料・ポーション・エンダーパールの使用（ItemUse/CombatActuator）を executor に追加。
   ただし single-action lock は ExecutorCore に一本化したまま（反射層は「即時中断」権を持つ設計にする）。
3. 目標選択: エンダーマン（中立・目を合わせない）、ブレイズ（遠距離・水/雪）、ガスト、ピグリン等の
   敵種ごとの対処表をコードで持つ（モデルに判断させない）。
4. 計測: 反応遅延（被弾→回避までのtick数）、戦闘勝率、死亡回数、戦闘中のLLM呼び出し回数（0であるべき）。
5. ホットリロードは戦闘中に走らせない（安全点でのみ世代交代）。freeze/resume を戦闘対応にする。
検証: 反応遅延の計測値をログに残し、死亡原因の内訳（mob種別/落下/溶岩）を WorldMemory の hazard に反映する。
```

## 長期方針: API料金の節約（性能を犠牲にしない範囲で常に意識）
```
方針: 「性能・正しさを落とさない節約」だけを行う。安さのために知能を落とす判断はしない。
具体策:
1. 通常経路は決定論ラダー＋（接地候補上の）Jev π/β のみ。LLM は例外時だけ（現行方針の徹底）。
2. Jev は局所判断に最適（低コスト・低遅延・確率出力）→ 判断は極力 Jev に集約。
   Mercury は「候補集合が足りない時」の提案生成器に限定（役割分離。#35 の原則）。
3. 質問は有界・圧縮 state のみ。同一 state hash の重複呼び出しは排除（ただし #15 の通り
   「キャッシュヒットで plan を捨てる／無限再適用」は禁止＝正しさ優先）。
4. カテゴリ別モデルルーティング: 軽い作業は quick/unspecified-low、重い設計のみ deep/oracle。
   調査は librarian/explore に委譲し、メイン文脈の消費を抑える。
5. 計測と可視化: `cost per meaningful progress`（サブゴール達成あたり／マイルストーンあたり）を
   mercury-calls.jsonl / jev-calls.jsonl から集計し、run の acceptance JSON に残す。
6. 目標: 例外呼び出しの成功率を上げて**呼び出し回数そのものを減らす**（安いモデルに落とすより効果が大きい）。
```
```
現状: /home/s0u7a/.config/opencode/opencode.jsonc
  "model":       "opencode-go/deepseek-v4.1-flash"
  "small_model": "opencode-go/deepseek-v4.1-flash"
  provider.commandcode → baseURL https://api.commandcode.ai/provider/v1
  （プラグイン: @brainervirus/opencode-commandcode）

指示（2026-09-18 更新）: **16時間は opencode-go で耐える。commandcode も同時に制限中のため切替不可**（解除後の選択肢として手順は残す）
節約優先度: 制限中は「文脈とトークンを消費しない」ことが最優先 →
  ・ポーリング禁止（タスクに任せて通知待ち）／返答は短く／大きい調査は librarian/explore へ委譲
  ・ゲート確認は tools/*.mjs の1コマンドに集約／長文トランスクリプトは読まない（成果物ファイルで検証）
切替手順（制限に達した時点で実行。実行中セッションが落ちる可能性があるので事前には書き換えない）:
  1) opencode.jsonc の "model" と "small_model" を `commandcode/deepseek-v4.1-flash` に変更
     （プロバイダIDが異なる場合は `opencode models | grep -i deepseek` 等で正確なIDを確認）
  2) 認証が未設定なら Command Code のキーを設定（キーは絶対にログへ出さない）
  3) 変更後は opencode を再起動し、`opencode models` で選択可能なことを確認
  4) 切替えた事実と理由を本ファイルに追記（どちらのモデルで走ったかを後から追えるように）
回避策（制限到達前にやれること）:
  ・サブエージェントは category を分けて安いモデル（quick/unspecified-low）へ寄せる
  ・大きい調査は librarian/explore に委譲し、メインの文脈消費を減らす
  ・長時間の自走は「タスク起動 → 通知待ち」に徹し、ポーリングしない
```

## 進捗ログ（一次証拠つき）```
2026-09-18 02:26 JST — ★節目: 掘削系マーカーが初めて非ゼロになった
  issue12 ゲート 4/6（3/6 から前進）: precond=363 ladderPrereq=216 maxTicks=202 gensLast5min=2 rawIron=0
  TOOL_CHOICE=4  DIG_PATH=4  JUMP_ATTEMPT=24  DESCEND_LIMIT=1  STAIRCASE=1
  → これまで全マーカー0で検証不能だった #7（道具選択）/ #8（hop順序・failure memory）/
    #9（DESCEND暴走）/ ジグザグ→階段 の修正が、身体の行動として観測できた
  → 連鎖: Mercury有効化（キャッシュループ解消、cached=false の新規計画）→ 前提チェーン差し替え（LADDER_PREREQ）
    → 実際に掘る、が成立
  残: rawIron=0（鉄鉱石未入手）。直近は WAIT（pos=29.5,60.0,34.3 rung=charcoal）
      → 次の詰め: 探索候補の不足。discoveredOres=[coal_ore,copper_ore,iron_ore] を活かす RETURN_TO_KNOWN_ORE が未実装（#14/#29）

2026-09-18 02:24 JST — Mercury有効化でキャッシュループ解消（暫定回避策）
  system2.config.json {"mercury": false} → {"mercury": true}（ホットリロード ms=155）
  ADVISOR source=mercury reason=wait_limit  strategy=mercury_patch_collect_coal   cost=0.000281 ms=6655 cached=false
  ADVISOR source=mercury reason=no_progress strategy=mercury_replace_collect_coal cost=0.000289 ms=4468 cached=false
  恒久修正は #15（cache hit は plan を再生／同一WAIT再発で無効化／実行不能戦略を grounding で拒否）

2026-09-18 02:05 JST — #12 着地（部分的）
  LADDER_PREREQ 出現（0 → 200超）／churn 9回/5分 → 2回/5分／maxTicks 121 → 202
  listenerLeak は false に（#13相当は改善）。ただし 1tick停止は残存。
```