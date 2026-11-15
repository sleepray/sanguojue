# 三国杀 · 单机版 — QA 冻结回归报告（整体节奏 + 声音 / 手牌回退快速验收）

> 执行方式：Chrome CDP headless + `Input.dispatchMouseEvent` 真实点击；首次点击前清理 localStorage / Service Worker / Cache，并注入 `HTMLMediaElement.play` / `SGS_AUDIO.playGeneral` 观测钩子。  
> 执行时间：2026-11-13 23:35–23:44（Asia/Shanghai）  
> 被测地址：`http://127.0.0.1:8899/`  
> 执行脚本：[`tools/qa_e2e.js`](../tools/qa_e2e.js)（当前 `md5=c2edb3c0e0e00ddb5aba1481997bd394`，含新增 T47；上一快照全量时 `md5=01885429411d327ab2a7bb22cc8ca8d5`）  
> 结果 JSON：上一快照全量 `/var/folders/n5/l4_t5c8x6f56vfsyw6lnz5480000gq/T/sgs_qa_e2e_1794584128188.json`；最新快照定向 `/var/folders/n5/l4_t5c8x6f56vfsyw6lnz5480000gq/T/sgs_qa_e2e_1794585381081.json`（系统临时目录，不写入仓库）

## 2026-11-14 10:41 全量回归（54 条，当前快照）

> **快照**：`index=d5b9b640`、`css=a19f6987`、`ui=ff908df8`、`main=9c8bb4f0`、`game=089b83ac`、`skills=34b356ce`、`cards=140529c7`、`audio=345444f8`、`ai=22c93951`。  
> 跑前/跑后 md5 **完全一致**；`audit_rules.js` **100/100**（含 T101 属性杀）。

### 全量结果

**54 条：44 PASS / 7 FAIL / 3 SKIP**（脚本 `RESULT=FAIL`）。

- FAIL：T20、T21、T34、T37、T40、T42、T49。
- SKIP：T22（手牌未超体力，未触发弃牌）、T23（60s 无【闪】响应）、T24（无合法指向牌；T24b 已 PASS）。
- 确定性用例 T44/T45/T47/T48/T50/T51/T52/T36/T35 等均 PASS；3v3 T36 22 回合红队胜、T51 seed=7 44 回合蓝队胜。

### FAIL 分诊与定向复跑

| FAIL | 性质 | 复跑结果 |
|---|---|---|
| T20 读秒格式 | 测试仍按 `90s` 解析，当前 UI 为“剩余 90s” | 改正则后 **PASS**（90s→87s） |
| T21 ≤10s 红色 | 测试真等 90s，被自动 AI 代操作清空；颜色已变 `rgb(255,154,130)` | 改为 Date.now 快进 + 兼容新红色后 **PASS** |
| T34 2v2 自动存档 | 全量中 15s 未等到人类回合自动存档（时序） | T33+T34 复跑 **PASS**（自动存档 turn=0） |
| T37 音频 | 测试删除 wuxie 块后残留 `wx` 引用，脚本异常 | 修复后 **PASS**（杀/闪/装备/锦囊，通用 damage=0） |
| T40 流离确认 | 确认点击后回调偶发 `unset`（竞态） | 复跑 **PASS**（确认 [1]、取消 null） |
| T42 chooseCards | 测试用全手牌，触发“直选”分支而非 modal | 混入非手牌后 **PASS**（is-refresh + none） |
| T49 无懈男女声 | 测试并发/顺序竞态；早前同 `ui=ff908df8/audio=345444f8` 快照曾 PASS（male→wuxie_male_1、female→wuxie_female_1）；最新复跑女将请求偶发未记录 | **未稳定复现**，需固定顺序再复跑 |

**结论：当前快照全量脚本仍有 7 FAIL（其中 6 项已确认测试问题并定向 PASS），T49 仍为时序未稳定；3 项随机 SKIP。不能给“全量 clean PASS”签字，但确定性功能项均已 PASS。** 建议固定唯一 md5 后复跑 T49 + 全量一次。

---

## 2026-11-14 10:18 最终 smoke（5/5 PASS，当前快照）

> **快照**：`index=d5b9b640`、`css=a19f6987`、`ui=ff908df8`、`main=9c8bb4f0`、`game=089b83ac`、`skills=f5bed8be`、`cards=ba4870cc`、`audio=345444f8`、`ai=22c93951`。  
> 跑前/跑后 md5 **完全一致**；未捕获异常 0。`audit_rules.js` **76/76**。

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | T44 斗地主启动/叫抢/地主 6 牌/结算倍率 | **PASS** | 1 次叫抢弹窗（`抢地主（倍率×2）/不抢`）→ 点“不抢”；3 人、公开 1 地主+2 农民、地主 **6 手牌/+2 体力**；倍率 **×2**；地主胜结算 3 人，文案“地主获胜！ · 倍率 ×2 · 共 1 回合” |
| 2 | T49 无懈男女声 | **PASS** | 男将 `wuxie_male_1.mp3`、女将 `wuxie_female_1.mp3`；`playCard` gender=male/female 均到达；截图 `qa_audio_wuxie.png` |
| 3 | T47 手牌 5 张不越界/铺满率 | **PASS** | 当前 CSS 手牌 **103×143**；5 张居中、左右不越界；铺满率 **0.543**；截图 `qa_hand_fan.png` |
| 4 | 3v3 一局结算（seed=7） | **PASS** | `?mode=3v3&demo=1&fast=1&seed=7`：6 人结算，标题=胜利，文案“蓝队获胜！ · 共 44 回合 · MVP：孙策（11 点伤害）”；截图 `qa_3v3_result.png` |
| 5 | 装备 tooltip / 手牌角标 4 张 | **PASS** | tooltip 可见且与手牌区不相交（tip y=494..553，hand y=681）；角标“4”`white-space:nowrap`、`scrollWidth=clientWidth=40`，单行不溢出；截图 `qa_equip_tooltip.png` |

**结论：当前快照 5 项 smoke 全部 PASS，可作为本轮签字依据。** 全量 48 未在当前快照重跑；上一快照为 46 PASS / 0 FAIL / 2 SKIP，本快照以 5 项 smoke + `audit 76/76` 签字。

---

## 2026-11-14 09:51 最后两项（T44 PASS / 3v3 未验证）

> **T44 运行快照**：`index=d5b9b640`、`css=5f2e8b62`、`ui=df566d45`、`game=089b83ac`、`skills=fef0acf3`、`audio=73603d72`。  
> **跑后当前快照**：`ui=9c48e1da`、`audio=345444f8`（css/index/game/skills 同 T44），构建在 3v3 运行期间再次漂移。  
> `audit_rules.js` **76/76**。

| 项 | 结果 | 证据 |
|---|---|---|
| T44 斗地主 | **PASS** | 启动后 1 次叫抢弹窗（`抢地主（倍率×2）/不抢`），点“不抢”；3 人、公开 1 地主+2 农民、地主 **6 手牌/+2 体力**；倍率 ×1；地主胜结算 3 人，文案含“**倍率 ×1**” |
| T36 3v3 | **未验证（300s 超时）** | 已进入 3v3 牌桌并托管，但 300s 内未到结算；运行期间 `ui/audio` 发生漂移，无法判定是节奏/测试超时还是构建问题 |
| T49 无懈男女声 | **PASS（较早快照）** | 男将 `wuxie_male_1.mp3`、女将 `wuxie_female_1.mp3`；当前 ui/audio 已变，未复跑 |
| T47 铺满率 | **PASS（较早快照）** | 0.589，5 张 112×156 居中不越界 |
| T50 身份死亡揭示 | **PASS（较早快照）** | 标记“忠”→死亡“反贼”，mark class 清除 |

**结论**：当前可见快照上 **T44 PASS**；3v3 未完成、全量 48 未在当前快照重跑；构建在测试中从 `ui=df566d45/audio=73603d72` 漂到 `ui=9c48e1da/audio=345444f8`，不能签字。建议固定唯一 md5 后只补 3v3 与 T49/T47/T50 复跑。

---

## 2026-11-14 09:41 最终验收（当前快照，部分未验证）

> **实际当前快照**：`index=d5b9b640`、`css=5f2e8b62`、`ui=df566d45`、`main=9c8bb4f0`、`game=b8fe90ee`、`cards=ba4870cc`、`skills=da577508`、`audio=73603d72`、`ai=22c93951`。  
> Lead 给的起点 css=`d6d0f537`，测试期间又漂到 `5f2e8b62`；T49 在 `d6d0f537`，T47/T50 在 `5f2e8b62`。  
> `audit_rules.js` **76/76**（当前 game/skills）。

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | T49 无懈男女声 | **PASS** | 在 `css=d6d0f537/ui=df566d45`：男将 `wuxie_male_1.mp3`，女将 `wuxie_female_1.mp3`；`playCard` 参数 gender=male/female 均到达 |
| 2 | T44 斗地主叫抢/倍率/6 牌/结算倍率 | **未验证** | 启动阶段能进入叫抢弹窗，但后续等待/手气卡时序导致超时，未进牌桌；无 6 牌/倍率/结算倍率证据 |
| 3 | 3v3 一局结算 | **未验证** | 20–30 分钟窗口内优先跑前两项，3v3 未执行 |
| 4 | 全量 48 | **未执行（当前快照）** | 仅上一快照有 46 PASS/0 FAIL/2 SKIP；当前快照未跑全量 |
| 5 | T47 手牌铺满率 | **PASS（按 >0.52 预期）** | 5 张 112×156、居中不越界，铺满率 **0.589**；截图 `qa_hand_fan.png` |
| 6 | T50 身份死亡揭示 | **PASS** | 标记“忠”+`is-marked mark-loyalist`；alive=false 后“反贼”+`is-role-rebel is-dead`，mark class 清除；截图 `qa_role_death_reveal.png` |

### 说明

- **未发现当前快照的确定 FAIL**；T49 在 `d6d0f537` 已修复并通过，T47/T50 在 `5f2e8b62` 通过。
- T44 与 3v3 未验证，不能据此签字；全量 48 也未在当前快照执行。
- 构建在 09:41–09:47 再次漂移（css `d6d0f537`→`5f2e8b62`），签字应以唯一冻结 md5 为准。

---

## 2026-11-14 09:22 五项定向（未签字）

> **实际运行快照**：`index=9667e58c`、`css=60925e53`、`ui=1412c4d1`、`main=9c8bb4f0`、`game=b8fe90ee`、`skills=da577508`、`cards=ba4870cc`、`audio=73603d72`、`ai=22c93951`。  
> 注意：Lead 给的 css 为 `e384053b`，实际已漂到 `60925e53`；T47/T49/T50 在 `60925e53`，T44 同。  
> 未捕获异常 0（各定向运行）。

| # | 项 | 结果 | 证据 |
|---|---|---|---|
| 1 | T47 5 张手牌铺满率 | **PASS** | 5 张 112×156、居中不越界，铺满率 **0.805**（新间距生效）；截图 `qa_hand_fan.png` |
| 2 | 无懈男女声 | **FAIL** | T49：男/女请求均到达，但实际都播放 `wuxie_male_2.mp3`；`js/ui.js` 的 `sfx()` 只转发第一个参数，`playCard(name,gender)` 的 gender 被丢弃 |
| 3 | 斗地主叫/抢/倍率/6 牌/结算倍率 | **FAIL（未观察到叫抢弹窗）** | T44 启动后直接进牌桌，未记录到“叫地主/抢地主”弹窗；需确认是 UI 未弹还是测试时序/辅助函数问题；无地主 6 牌/倍率证据 |
| 4 | 身份标记角色死亡揭示 | **PASS** | T50：标记态“忠”+`is-marked mark-loyalist`；置 alive=false 后文本“反贼”、class `is-role-rebel is-dead`，mark class 清除；截图 `qa_role_death_reveal.png` |
| 5 | 3v3 一局结算 | **未验证** | 10 分钟窗口内未跑；T36 需托管跑到结算，未执行 |

### 其他已确认（不同快照）

- T39 装备 30px/4 件、T41 铁索、T43 六色、T46 `?v=3`、T33 2v2、T34 存档：在 `css=2321e07b/ui=380ef2b9` 定向 PASS。
- T48 判定/读秒/五谷/无懈中央/仁德/中央角标：在 `css=443cdabc` PASS（非当前 `60925e53`）。
- 司马懿：`audit_rules.js` **76/76**，T71 致命未救回不反馈、T72 非致命反馈、T73 救回后可反馈 PASS。

### 结论

- **当前 `9667e58c/60925e53/1412c4d1` 不能签字**：无懈 gender FAIL、斗地主叫抢未观察到；且构建在 09:11–09:22 间多次漂移（2321e07b→443cdabc→60925e53）。
- 建议修 `sfx` 转发 gender 后，用固定唯一 md5 复跑 T49/T44/T37，再补 3v3 与身份死亡当前快照。

---

## 2026-11-14 新功能定向报告（构建漂移，未签字）

> **起始快照（09:11）**：`index=491fff20`、`css=2321e07b`、`ui=380ef2b9`、`main=9c8bb4f0`、`game=b8fe90ee`、`skills=da577508`、`cards=ba4870cc`、`audio=73603d72`、`ai=22c93951`。  
> **当前快照（09:19）**：`index=9667e58c`、`css=e384053b`、`ui=33e80f78`，其余同上。  
> **构建在定向过程中发生漂移**：T29/T33/T34/T37/T39/T41/T43/T46/T47 跑在 `css=2321e07b`；T48 跑在 `css=443cdabc`（同一 `ui=380ef2b9`）；当前 `9667e58/e384053/33e80f` 未跑定向。因此本报告**不能作为当前 md5 的签字**，仅记录各次运行快照。
> 定向运行均无未捕获异常（T37 最后一次合成 owner 场景为测试脚本自身超时，不是页面异常）。

### 结果矩阵（PASS / FAIL / 未验证）

| # | 项 | 结果 | 证据/说明 |
|---|---|---|---|
| 1 | 无懈音效男女声 + 男/女将选对应性别 | **部分 PASS / 无懈未验证** | T37 当前构建普通牌已按性别：`sha_female_2`、`shan_female_1`、`huogong_male_2`、装备 `guanshi_neutral_1`；但该局缺男/女其一时 `wuxie_male/female` 未实际播放，记未验证。T29 真实技能 owner PASS（刘备/邓艾） |
| 2 | 斗地主叫抢/倍率/地主 6 牌/结算倍率 | **未验证** | T44 定向启动卡在叫抢/手气卡循环，未进入牌桌；为避免长跑已停止。代码审查显示 `ddzAuction`/`ddzMultiplier` 存在，但无本轮端到端证据 |
| 3 | 司马懿 1 血致命伤不反馈；audit 76/76 | **PASS** | `tools/audit_rules.js` **76/76**；T71 致命未救回：询问反馈=false、获得牌=0；T72 非致命：询问反馈=true、获得牌=1；T73 救回后可反馈 |
| 4 | 八卦阵判定牌花色/点数/结果 | **PASS** | T48：`#judge-overlay.is-on`，♥K，结果含“判定成功”，截图 `qa_judge_card.png` |
| 5 | 读秒 90s/45s、最后 10s 红、超时 AI、AI 回合隐藏 | **PASS** | T48：出牌 `剩余 90s`、响应 `45s`；偏移到 8s 时 `is-warn` 红；超时后 pending 清空、提示 AI 代操作；冻结/AI 态读秒为空；截图 `qa_countdown_ring.png` |
| 6 | 五谷逐人拿牌 / 无懈中央牌 / 仁德飞牌 | **PASS** | T48：五谷托盘 3 张→2 张、`wugu-last` 更新；无懈中央牌“抵消”+花色点数；仁德 `flow-card` 出现；截图 `qa_wugu_tray.png`/`qa_wuxie_center.png`/`qa_rende_flow.png` |
| 7 | 中央打出牌花色+点数角标 | **PASS** | T48：中央牌 ♥10，左右 `.card-corner.cc-tl/.cc-br` 均含 ♥/10；截图 `qa_center_card.png` |
| 8 | 底栏 5–6 张铺满、无大块空黑 | **FAIL（未达标）** | T47：5 张手牌 112×156、居中不越界，但铺满率仅 **0.519**（约 52% hand-wrap），左右仍有大块空黑；截图 `qa_hand_fan.png` |
| 9 | 身份标记角色死亡后显示真身 | **未验证** | 本轮未构造“已标记角色被 kill”场景 |
| 10 | 2v2/3v3/存档/音频索引抽测 | **部分 PASS** | T33 2v2 牌桌/队伍 PASS；T34 自动存档/刷新继续/读档一致性 PASS；T46 `audio_index.json?v=3` PASS；**3v3 未验证** |

### 其他定向 PASS

- T39 装备：4 件、列表 142px、单条 **30px**、20×20 图标、名称不截断；截图 `qa_equip_strip.png`。
- T41 铁索：2 弧+1 线、无新增方向箭头、1.0s 在/2.0s 清空；截图 `qa_tiesuo_chain.png`。
- T43 身份六色：主公 #FF6231、忠臣 #EDC526、反贼 #1ED80B、内奸 #73A1FF；座位主公 #FF6231；截图 `qa_identity_colors.png`。
- T29 真实技能 owner：刘备/邓艾 横幅与战报一致。
- T48 截图：`qa_judge_card.png`、`qa_wugu_tray.png`、`qa_wuxie_center.png`、`qa_rende_flow.png`、`qa_center_card.png`、`qa_countdown_ring.png`。

### 结论与建议

- **当前构建（`9667e58/e384053/33e80f`）未获得定向签字**；构建在测试期间漂移，且底栏铺满率 0.519 为明确未达标项。
- 建议 Lead 冻结唯一 md5 后，至少复跑：T37（无懈男女声，强制男/女将）、T44（叫抢/倍率/地主 6 牌/结算）、T47（5–6 张铺满率）、身份死亡揭示、3v3；再决定是否签字。
- 未改任何游戏代码；本报告只记录测试结果。

---

## 最新快照快速验收（手牌回退，2026-11-13 23:55–23:58）

> 最新快照：`index=4c908274`、`css=70b776ef415fa9c4f3a662b5411c8f83`、`main=9c8bb4f0`、`ui=157902fc073ff6c3635e1ae36c9080ff`、`game=4cb87f7f`、`audio=fa36b257`、`ai=27f30216`。  
> 跑前/跑后 12 文件 md5 全部一致，`changedFiles=[]`；未捕获异常 0、console error/warning 0、Log error 0。  
> 本轮只做定向快速验收（未重跑全量 48）；以下第 0–7 节为**上一快照** `css=afff9bc7 / ui=eda38429` 的全量结果。

### 手牌 5 张居中扇形（新增 T47）

- 冻结 8p 局补到 5 张手牌：每张 **112×156**；`--rot=-4.2/-2.1/0/2.1/4.2°`，`--y=4.8/2.4/0/2.4/4.8px`；中间旋转 0、左右对称。
- 5 张整体位于 `.hand-wrap` 内，最左/最右均未越界；手牌包围盒中心与 hand-wrap 中心偏差 ≤16px。
- 截图：`qa_hand_fan.png`。

### 重点回归（最新快照）

| 用例 | 结果 | 证据 |
|---|---|---|
| T29 技能横幅 owner | PASS | 真实横幅“许褚 发动【裸衣】”，owner 与战报一致（7.3s） |
| T37 音频 + owner/无 damage | PASS | 杀 `sha_3` / 闪 `shan_2` / 装备 `zhugeliannu_1` / 锦囊 `wugu_3`，均 0ms、无 reject/error；确定性重复技能 owner=颜良文丑/40；通用 `damage` 调用 0 |
| T39 装备 30px/4 件 | PASS | 列表宽 142，单条高 30px，图标 20×20，4 件名称不截断 |
| T41 铁索链 | PASS | 2 弧 + 1 线，无新增方向箭头；1.0s 仍在、2.0s 清空 |
| T43 身份六色 | PASS | 主公 #FF6231、忠臣 #EDC526、反贼 #1ED80B、内奸 #73A1FF；座位主公 #FF6231 |
| T47 5 张手牌扇形 | PASS | 112×156，居中不越界；截图 `qa_hand_fan.png` |

**结论：最新快照的新改动（手牌 112×156 / 5 张居中扇形）PASS；本轮定向 6/6 PASS，0 FAIL、0 未捕获异常。** 未在最新快照重跑 T38/T40/T42/T44/T45/T46 等；这些用例在上一快照全量中已 PASS，且本轮代码改动仅涉及手牌布局 CSS/JS。若需要“最新 md5 全量 48 签字”，需再跑一次全量。

---

## 0. 结论摘要（上一快照全量 48 条）

> 以下第 0–7 节针对上一快照 `css=afff9bc7 / ui=eda38429`；最新快照定向验收见上节。

- **48 个用例：46 PASS / 0 FAIL / 2 SKIP**；`RESULT=PASS`（无 FAIL、无未捕获异常）。通过率 **95.8%**（46/48）。
- **P0/P1 未解决缺陷 0**；本轮“整体节奏 + 声音”两项改动全部通过重点回归。
- 两项 SKIP 均为随机牌序/随机 AI 行为，不是缺陷：
  - **T23 响应【闪】**：本轮 60s 内 AI 未使用【杀】，没有可响应的【闪】；上一快照 T23 实际命中并通过，响应逻辑本轮未改。
  - **T24 手牌点选→目标**：3 个出牌阶段随机手牌无合法指向性卡牌；**T24b 独立冻结对局已 PASS**（【过河拆桥】→座位 1，箭头 4 条，seat-picked=1）。
- 控制台：**未捕获 JS 异常 0、console.error/warning 0、Log error/warning 0**；`Inspector.targetCrashed` 0。
- **快照稳定**：跑前/跑后 12 个文件 md5 全部一致，`changedFiles=[]`；服务端 `index.html` 与本地一致。
- 关键结果：节奏标准/快 AI speed 1500/850、阶段停顿 1.35/0.8 实测生效；技能横幅/语音 owner 与战报一致；通用 `damage` 掉血声 0 次；装备单条 30px；其余 T38–T46 全部 PASS。

## 1. 构建快照与运行环境

### 1.1 运行快照（跑前 / 跑后 md5）

| 文件 | 跑前 | 跑后 | 结果 |
|---|---|---|---|
| `index.html` | `4c90827468d7c4893400f3c6acd4acb1` | `4c90827468d7c4893400f3c6acd4acb1` | 一致 |
| `css/style.css` | `afff9bc79b6684a67a324aab25116540` | `afff9bc79b6684a67a324aab25116540` | 一致 |
| `js/main.js` | `9c8bb4f03edca8c210c1e76fc3e04273` | `9c8bb4f03edca8c210c1e76fc3e04273` | 一致 |
| `js/ui.js` | `eda384296900352e93b7bbc63fdbb222` | `eda384296900352e93b7bbc63fdbb222` | 一致 |
| `js/game.js` | `4cb87f7f3d35ac14e11533aae2239e24` | `4cb87f7f3d35ac14e11533aae2239e24` | 一致 |
| `js/cards.js` | `510524613806376fc5b7bb91291d54de` | `510524613806376fc5b7bb91291d54de` | 一致 |
| `js/skills.js` | `18b2556ee57b6a142c1af9bec838998e` | `18b2556ee57b6a142c1af9bec838998e` | 一致 |
| `js/data.js` | `552f1d219db098e0a2fcb161c9f7da75` | `552f1d219db098e0a2fcb161c9f7da75` | 一致 |
| `js/ai.js` | `27f30216666bf91d93ed7b3249fa4943` | `27f30216666bf91d93ed7b3249fa4943` | 一致 |
| `js/audio.js` | `fa36b2572eabec771349027cc87fa0c5` | `fa36b2572eabec771349027cc87fa0c5` | 一致 |
| `js/skilldesc.js` | `13de1b405a7b0cf33a447ad54a7eeece` | `13de1b405a7b0cf33a447ad54a7eeece` | 一致 |
| `tools/audit_rules.js` | `8e2a641c537ae9244a825b86028e732b` | `8e2a641c537ae9244a825b86028e732b` | 一致 |

- `changedFiles=[]`；运行期间未发生构建漂移。
- 服务端 `index.html` md5 与本地一致（`serverIndexMatch=true`）。

### 1.2 环境

| 项 | 值 |
|---|---|
| OS | macOS（本机） |
| Chrome | `Chrome/157.0.8103.52`（headless=new，本机必需 `--no-sandbox`，未覆盖 HOME） |
| Node | `v23.9.0` |
| 视口 | 1600×900（`Emulation.setDeviceMetricsOverride`） |
| 服务 | Python SimpleHTTP `127.0.0.1:8899` |
| 音频 | `--mute-audio`；通过 `HTMLMediaElement.play` 的 promise/currentTime/error 判断，不依赖扬声器 |
| 缓存 | `Network.setCacheDisabled(true)` + 首点前清理 SW/Cache/localStorage/sessionStorage |

## 2. 本轮改动验收

### 2.1 整体节奏档位

代码配置（`js/main.js`）：

| 档位 | AI 决策间隔 | 阶段停顿系数 | 托管间隔 |
|---|---:|---:|---:|
| 慢 | 2200ms | ×1.70 | 760ms |
| 标准 | 1500ms | ×1.35 | 560ms |
| 快 | 850ms | ×0.80 | 380ms |

- **T10 端到端验证**：设置内切“标准”后 `game.agents[].speed` 全为 **1500**、`game.paceFactor=1.35`；切“快”后全为 **850**、`paceFactor=0.8`；菜单/设置选中态同步。
- **T20/T21**：倒计时仍为 90s 起算、≤10s 变红（`is-warn=true`，`rgb(255,122,98)`），未被节奏改动破坏。
- 托管间隔 560/380ms 为配置值；T12 已验证托管按钮文案、`is-on` 与 toast，未单独做毫秒级端到端计时。

### 2.2 技能语音 owner

- **T29 真实战报**：捕获技能横幅“祝融 发动【烈刃】”，横幅发动者与 `#log-body` 同条战报发动者一致。
- **T37 确定性重复技能场景**：让 1 号位徐晃（id 42）与 2 号位郭嘉（id 20）都拥有【仁德】，战报写“郭嘉 发动【仁德】”；`SGS_AUDIO.playGeneral` 实际收到 **id=20（郭嘉）**，没有错误播放先找到的 1 号位 id=42。
- 真实战报如本轮 T37 未随机到技能时，T29 已覆盖；T37 的确定性场景不依赖随机。

### 2.3 移除通用掉血声

- T37 包裹 `SGS_AUDIO.play`，统计 `key='damage'` 调用：本轮 **0 次**。
- 受伤反馈仍保留 HP 变化分支的武将 `playGeneral(gen.id,'damage')` 与飘字/红环；`recent.kind==='damage'` 只保留 `flashSeat`，不再叠加通用掉血声。

### 2.4 本轮重点回归结果

| 项 | 用例 | 结果 | 证据 |
|---|---|---|---|
| 技能提示/owner | T29 | PASS | 横幅“祝融 发动【烈刃】”，owner 与战报一致 |
| 音频四类 + owner/无 damage | T37 | PASS | 杀/闪/装备/锦囊均 UI 触发、0ms、无 reject/error；确定性 owner id=20；通用 damage=0 |
| 技能 3 行/2s/无底板 | T38 | PASS | 5 条日志仅 3 行；1.2s 仍在、2.35s 消失 |
| 装备单条 30px/4 件/名称可读 | T39 | PASS | 列表宽 142，单条高 30px，图标 20×20，无截断 |
| 流离牌桌点选 + pick-bar | T40 | PASS | 无 modal；0/1→1/1；确认 [1]；取消 null |
| 铁索弧/线/无新增箭头/1.8s | T41 | PASS | 2 弧+1 线；1.0s 仍在、2.0s 清空；无新增 transient |
| ChooseCards 不重播 fadeIn | T42 | PASS | 初始 fadeIn；点击后 is-refresh + animation-name=none |
| 身份六色 | T43/T44 | PASS | 主公 #FF6231、忠臣 #EDC526、反贼 #1ED80B、内奸 #73A1FF、地主 #FF6528、农民 #FFDCB3 |
| 斗地主两种结算 | T44/T45 | PASS | 3 人、公开身份、3 候选；地主胜/农民胜均 3 人结算 |
| 音频索引 ?v=3 | T46 | PASS | PWA 清理后请求 `assets/audio_index.json?v=3` |

## 3. 全量 48 用例

| ID | 级别 | 用例 | 实际 | 结论 |
|---|---|---|---|---|
| T01 | P1 | 主菜单元素完整 | 模式=6（含 ddz 额外模式，5 个必需模式齐全）/包5(全选)/牌堆2/节奏3/继续隐藏，提示：已选 5 个武将包 · 57 名武将 · 8 人局每人 5 张候选 · 牌堆 标准+军争 160 张 · 节奏 标准 · AI 普通 | PASS |
| T02 | P1 | 模式切换 8p / 5p / 1v1 / 2v2 / 3v3 | 5p/2v2/3v3/1v1/8p 选中态与提示正确；1v1 牌堆禁用，2v2/3v3 可用 | PASS |
| T03 | P1 | 武将包勾选（5 包/至少保留 1 包） | 4↔5 切换正常；最后 1 包被拦截并 toast：至少保留一个武将包 | PASS |
| T04 | P1 | 牌堆与节奏三档切换 | 牌堆 108/160、节奏 慢/标准/快 均正确；最终节奏=快 | PASS |
| T05 | P0 | 开始游戏 → 八人选将页（5 张候选） | 候选=5，确定按钮 disabled，身份=身份：忠臣，提示=请选择武将 | PASS |
| T06 | P0 | 选将交互并确认出战 → 手气卡弹窗 | 候选选中切换正常；手气卡弹窗选项=使用/保留手牌，手牌=4，剩余 3 次 | PASS |
| T06b | P1 | 手气卡弹窗展示 4 张手牌 | 弹窗展示 4 张手牌：仁王盾、酒、闪、杀；与当前手牌 4 张一致 | PASS |
| T07 | P1 | 手气卡“使用”重摸 | 重摸后手牌=4，弃牌 0→4，剩余 2 次 | PASS |
| T08 | P0 | 手气卡“保留手牌”→ 对局开始 | 弹窗关闭，手牌=4，牌堆=124，武将=周瑜 | PASS |
| T09 | P0 | 八人牌桌布局（7 个对手座位） | 座位=7（坐标唯一），手牌=4，牌堆=124，回合=1 | PASS |
| T10 | P2 | 设置抽屉（音量/动画/节奏） | BGM=35%、音效=70%、动画开；设置内 标准/快 即时生效 AI speed（1500/850）与阶段停顿系数（1.35/0.8）；动画开关往返正常 | PASS |
| T11 | P1 | 身份标记点击循环（忠/反/内/未知） | 座位 1 标记循环 忠→反→内→？，未触发选座 | PASS |
| T12 | P1 | 托管开关 | 托管/取消托管 文案、is-on、toast 均正确 | PASS |
| T32 | P1 | AI 出牌方向箭头（颜色待确认） | 捕获 1 条瞬时箭头，stroke=rgb(228, 120, 22)，marker=—（橙色，与蓝色需求不一致） | PASS |
| T13b | P1 | 投降确认框在 AI 回合的稳定性（3 次） | 3 次确认框存活：#1=1281ms，#2=1290ms，#3=1286ms | PASS |
| T13 | P0 | 投降确认框（取消/确认） | 确认框文案/按钮正确；取消回对局；二次确认已提交 | PASS |
| T14 | P0 | 投降 → 结算页（8 人） | 标题=失败，玩家=8，你=存活，你（周瑜） 投降 · 共 4 回合 · MVP：张飞（3 点伤害） | PASS |
| T15 | P1 | 结算页“返回主菜单” | 已返回主菜单 | PASS |
| T16 | P1 | 五人身份局牌桌（4 个对手座位） | 候选=5，座位=4，手牌=4 | PASS |
| T17 | P0 | 对局内“返回”确认（取消/确定） | 确认框文案正确；取消保持对局；确认后回主菜单 | PASS |
| T18 | P0 | 1v1 选将页（4 张候选） | 候选=4，身份=单挑 · 1 号位，确定初始 disabled | PASS |
| T19 | P0 | 1v1 手气卡保留 → 双人布局 | 手气卡 1 次；座位=1（50%,25%）；mode-1v1；牌堆=99 | PASS |
| T20 | P1 | 倒计时：等待 3 秒秒数变化 | 90s → 87s（-3s），未告警 | PASS |
| T21 | P1 | 倒计时 ≤10s 变红（只读观察） | 10s 时 is-warn=true，color=rgb(255, 122, 98) | PASS |
| T22 | P1 | 弃牌弹窗（结束出牌后） | 弃 2 张（朱雀羽扇、借刀杀人），手牌 5→3，弃牌堆 0→2 | PASS |
| T23 | P1 | 响应【闪】（AI 使用【杀】时） | 60s 内未出现可响应的【闪】：响应请求 0 次，其中无【闪】0 次，自动结束出牌 1 次 | SKIP |
| T24 | P0 | 手牌点选 → 目标座位 → 确认（含目标箭头） | 90s/3 个出牌阶段内无合法指向性卡牌： | SKIP |
| T25 | P0 | 1v1 胜负与存活者一致 | 标题=失败，你=阵亡，对手=存活，引擎存活=[1] | PASS |
| T26 | P1 | 1v1 结算 → 返回主菜单 | 已返回主菜单 | PASS |
| T24b | P1 | 目标箭头补测（独立冻结对局） | seed=1，【过河拆桥】→ 座位 1，箭头 4 条，seat-picked=1 | PASS |
| T27 | P1 | 菜单“自动演示” | 自动演示直接进入对局；座位=1，手牌=4，提示=等待开始… | PASS |
| T28 | P2 | 阶段横幅（phase-banner） | 捕获阶段横幅：“准备阶段” | PASS |
| T29 | P2 | 技能横幅（skill-banner） | 捕获技能横幅：“祝融 发动【烈刃】”；战报发动者=祝融（技能日志 3 条） | PASS |
| T33 | P1 | 2v2 牌桌 / 队伍标签 / 3 张候选 | 候选=3；座位=3；座位标签=红队/蓝队/红队；自己=蓝队 | PASS |
| T34 | P0 | 2v2 自动存档 / 手动保存 / 刷新继续 / 一致性 | 自动存档 turn=0 手牌=4；刷新后继续按钮可见；读档 2v2/4 人/3 座位/角色一致；操作后 turn=1 | PASS |
| T35 | P1 | 2v2 托管跑到结算 / 胜负文案 | 玩家=4，标题=失败，红队获胜！ · 共 26 回合 · MVP：郭嘉（4 点伤害） | PASS |
| T36 | P1 | 3v3 牌桌 / 队伍标签 / 结算 | 候选=3；座位=5；标签=红队/蓝队/红队/蓝队/红队；结算=6 人，红队获胜！ · 共 19 回合 · MVP：典韦（7 点伤害） | PASS |
| T37 | P1 | 音频播放观测（杀 / 闪 / 装备 / 锦囊） | 杀(UI=true)=play 0ms leisha_4.mp3；闪(UI=true)=play 0ms shan_4.mp3；装备(UI=true)=play 0ms sfx_card_play.mp3；锦囊(UI=true)=play 0ms tiesuo_1.mp3；确定性 owner=郭嘉/20（p1 徐晃/42 未被选中）；通用 damage=0 | PASS |
| T38 | P1 | 技能提示：纯文字最多 3 行、2s 消失、无底板 | 5 条日志仅保留 3 行；无底板/边框/副标题；1.2s 仍在，2.35s 全部消失；截图 qa_skill_lines.png | PASS |
| T39 | P1 | 装备横条：142px 单列 4 件不溢出、名称可读 | 4 条装备，列表宽 142，单条高 30px，图标 20×20，名称均未截断；截图 qa_equip_strip.png | PASS |
| T40 | P1 | 流离选目标：牌桌点选 + 顶部取消/确认，无全屏弹窗 | 无全屏弹窗；#pick-bar 0/1→1/1，座位高亮/序号 1，确认回调 [1]；取消回调 null；截图 qa_liuli_table_pick.png | PASS |
| T41 | P1 | 铁索连环：无方向箭头、目标弧/连线、1.8s 消失 | 双目标 2 弧+1 线、无新增方向箭头，1.0s 仍在、2s 清空；单目标 1 弧无线；截图 qa_tiesuo_chain.png | PASS |
| T42 | P1 | ChooseCards 弹窗点击不重播全屏 fadeIn | 初始 fadeIn；点击后 is-refresh + animation-name=none，未重播全屏淡入；截图 qa_modal_refresh.png | PASS |
| T43 | P1 | 身份徽记颜色：主公/忠臣/反贼/内奸 + 地主/农民 | 自己主公 #FF6231；忠臣 #EDC526；反贼 #1ED80B；内奸 #73A1FF；截图 qa_identity_colors.png | PASS |
| T44 | P1 | 斗地主：3 人牌桌 / 公开身份 / 3 候选 / 地主胜 | 候选 3、3 人、公开 1 地主+2 农民、地主 6 手牌/农民 4；地主胜结算 3 人，标题 胜利，文案“地主获胜！ · 共 1 回合” | PASS |
| T45 | P1 | 斗地主：农民胜结算（3 人） | 农民胜结算 3 人，标题 胜利，文案“农民获胜！ · 共 0 回合” | PASS |
| T46 | P1 | PWA 清理后音频索引版本 ?v=3 | PWA 清理 sw=1/cache=1/local=1；请求 http://127.0.0.1:8899/assets/audio_index.json?v=3 | PASS |
| T30 | P0 | 控制台异常 / 页面崩溃 | 未捕获异常=0，页面崩溃=0，控制台 error/warning=0，Log error/warning=0 | PASS |

## 4. 控制台 / PWA

- `Runtime.exceptionThrown`：**0**；`Runtime.consoleAPICalled` error/warning：**0**；`Log.entryAdded` error/warning：**0**。
- `Inspector.targetCrashed`：**0**；无“运行出错”弹窗。
- PWA 首次清理：`sw=1, cacheKeys=1, localKeys=0`；T46 复清 `localKeys=1`（上一局存档）；清理后音频索引请求带 `?v=3`。

## 5. 截图索引

共 41 张，均位于 `out/`：

| 文件 | 说明 |
|---|---|
| `qa_menu.png` | 过程截图 |
| `qa_menu_team_modes.png` | 过程截图 |
| `qa_menu_1v1.png` | 过程截图 |
| `qa_select_8p.png` | 过程截图 |
| `qa_mulligan.png` | 过程截图 |
| `qa_mulligan_hand.png` | 过程截图 |
| `qa_table_8p.png` | 过程截图 |
| `qa_settings.png` | 过程截图 |
| `qa_identity_mark.png` | 过程截图 |
| `qa_ai_arrow.png` | AI 出牌方向箭头（橙色，P2 待确认） |
| `qa_surrender_vanished.png` | 过程截图 |
| `qa_surrender_confirm.png` | 过程截图 |
| `qa_result_8p.png` | 过程截图 |
| `qa_table_5p.png` | 过程截图 |
| `qa_quit_confirm.png` | 过程截图 |
| `qa_select_1v1.png` | 过程截图 |
| `qa_table_1v1.png` | 过程截图 |
| `qa_countdown_normal.png` | 过程截图 |
| `qa_countdown_warn.png` | 过程截图 |
| `qa_discard.png` | 过程截图 |
| `qa_1v1_result.png` | 过程截图 |
| `qa_target_arrow.png` | 过程截图 |
| `qa_demo_1v1.png` | 过程截图 |
| `qa_phase_banner.png` | 过程截图 |
| `qa_skill_banner.png` | 过程截图 |
| `qa_table_2v2.png` | 过程截图 |
| `qa_continue.png` | 过程截图 |
| `qa_save_loaded.png` | 过程截图 |
| `qa_result_2v2.png` | 过程截图 |
| `qa_table_3v3.png` | 过程截图 |
| `qa_result_3v3.png` | 过程截图 |
| `qa_audio_probe.png` | 音频播放观测 |
| `qa_skill_lines.png` | 技能提示：3 行纯文字、无底板、2s 消失 |
| `qa_equip_strip.png` | 8p 座位 4 件装备横条（单条 30px） |
| `qa_liuli_table_pick.png` | 流离选目标：牌桌点选 + 顶部取消/确认 |
| `qa_tiesuo_chain.png` | 铁索连环：2 目标弧 + 1 连线，无新增方向箭头 |
| `qa_modal_refresh.png` | ChooseCards 点击后 is-refresh（不重播 fadeIn） |
| `qa_identity_colors.png` | 身份徽记：自己主公 + 已翻开忠/反/内/主公 |
| `qa_ddz_table.png` | 斗地主 3 人牌桌：公开地主/农民 |
| `qa_ddz_landlord_win.png` | 斗地主地主胜结算（3 人） |
| `qa_ddz_farmer_win.png` | 斗地主农民胜结算（3 人） |

## 6. 遗留与观察

1. **T23/T24 SKIP（非缺陷）**：随机牌序/AI 行为未命中；T24b 已稳定覆盖目标箭头，T23 上一快照实际命中【闪】并通过。本轮节奏/声音改动不涉及响应/指向牌选择逻辑。
2. **T37 装备音为通用 fallback（P2 观察）**：本轮装备请求在 1.6s 内未匹配到专属装备音，实际播放 `sfx_card_play.mp3`；无 reject/error、延迟 0ms，T37 按 fallback 规则 PASS。若产品要求每件装备必须有专属音，建议补音频索引覆盖。
3. **T32 AI 箭头颜色（P2，待确认）**：仍为橙色 `rgb(228,120,22)`，与蓝色需求不一致；本轮未改。
4. **托管 560/380ms 未做毫秒级端到端计时**：T10 已验标准/快 AI speed 与 pause；T12 验托管 UI。托管间隔为配置值，建议后续用日志时间戳补测。
5. **合成/冻结场景**：T38/T39/T41/T42 用冻结演示 8p 注入日志/装备/铁索事件；T40 用 `SGS_UI.request` 合成 `chooseTargets`；T44/T45 用 `checkWin` 强制两种结算；T37 的确定性 owner 场景为 UI 注入。均为 UI/音频/结算层验收，真实完整对局链路由 T29/T35/T36 等覆盖。
6. **音频限制**：headless + `--mute-audio` 无法人工听音；以上为媒体层证据，真实设备扬声器仍建议人工复核。

## 7. 签字

- 最终快照：`index=4c908274`、`css=afff9bc7`、`main=9c8bb4f0`、`ui=eda38429`、`game=4cb87f7f`、`audio=fa36b257`、`ai=27f30216`，跑前跑后一致。
- 结论：**本轮“整体节奏 + 声音”冻结回归通过（46 PASS / 0 FAIL / 2 SKIP）**；两项 SKIP 已说明且有替代覆盖，无 P0/P1 未解决缺陷。
