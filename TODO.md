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

## 進捗ログ（一次証拠つき）
```
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