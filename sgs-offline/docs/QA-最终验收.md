# 三国杀单机版 · 当前验收快照

> 历史报告 `docs/QA回归报告.md` 中有旧快照/旧 audit 数字；本文件以最新构建为准。

## 构建

```text
index.html   35bab02ba8606d3f20350045613c9147
css/style.css c9f8ef477ecfe799355c9e47c5e16875
js/ui.js      82ad969d709aab055c8226e7e162468b
js/main.js    d88ef4dcba0302cc11fd5efc43cfee63
js/game.js    4c89b5c6c88740048847b5e17a5779cf
js/cards.js   681938c8e184533fd60d018d0eb2e185
js/skills.js  df7d8f9f05bbe039fede3fef5ed067b5
js/data.js    3bd2b7bae4e6de46596b38f4062596f5
js/ai.js      c68503a75c244a8d0f9664571626f586
js/audio.js   7a94c27ad7e93949c8c6f925af3133fc
```

## 验收

- `audit_rules.js`：**197/197**
- `verify_data.js`：**ALL PASS**
- 全量 54：**51 PASS / 0 FAIL / 3 SKIP**
  - SKIP：T22（手牌未超体力）、T23（60s 无闪）、T24（随机无合法指向牌）
- 未捕获异常 0、console error/warning 0、Log error/warning 0
- 覆盖：8p/5p/1v1/2v2/3v3/斗地主、存档、音频、读秒、判定、五谷、无懈、借刀、身份死亡、tooltip。

## 最近修复

- 火攻目标自己选择展示牌（T197）；
- 判定改为引擎结构化 judge 事件，乐不思蜀/兵粮/闪电/八卦/铁骑统一浮层（T198）；
- 无懈自用音效走战报路径；
- 借刀两段箭头；原版 DirectionLine 无端点白点/箭头；
- 中央响应牌与已出牌层互斥；
- 战斗 BGM 延迟到真正开局；
- 邓艾【急袭】补定义，不再显示 `jixi`。

## 明确缺口

- 3v3 59 池 / 1v1 原版池：无权威池表；
- 特殊牌卡图（本地缺 CardsNew 纹理）、特殊牌其它语音；
- 7 张马匹、周泰/张角/于吉无本地语音；
- 少数变体技能、地主第二将势力/将池、押注/门票/30 分钟平局、个人/公共牌堆拆分；
- 通栏顶栏仍是单机版有意偏离。
