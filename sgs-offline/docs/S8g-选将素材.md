# S8g · 选将界面重做 + 「换一批」素材（1.0.8 收尾2 / 任务 1.9 + 1b）

分支 `fix/1.0.8-balance`，基线 HEAD `b40cb98`。
只改选将相关：`index.html`（选将区）、`css/b8g-select.css`（新建）、`js/ui.js`（选将段）、`js/main.js`（返回键）。
未动 `js/game.js` / `js/ai.js` / `js/cards.js` / `js/skills.js` / HUD 对局区 / 存档。

---

## 一、结论

选将界面已按 `docs/选将界面示意v2.png` 重做完成：

- 顶部：**选择武将（左）· 大号彩色身份牌 + 胜利目标（中）· 提示（右）**，1v1 不显示身份牌。
- 卡片：**横向卡**（左立绘 / 右名字·性别·体力·称号·包·技能完整描述），**≥900 三列、否则两列、412 竖屏一列**；高度按可用高度均分（最低 110），放不下时**只滚动卡片区**，标题与底栏固定，底部渐隐「↓ 还有 N 张」。
- 底部操作栏：**「← 返回」(88×44 描边) · 已选：X · 「换一批」(96×44 描边) +「确定出战」(112×44 金色)**。
- 长按任意卡 → 详情浮层（势力/性别/体力/包/称号 + 每技能名与类型标签 + 完整描述 + 主公技规则 + 觉醒获得技能 + 关闭/选择此武将）。
- 「换一批」接 `game.canSwapCandidates/swapCandidates`，不限次、清选中、防连点、池不足置灰。

---

## 二、根因（旧实现）

| # | 问题 | 旧位置 |
|---|---|---|
| 1 | 选将卡片是**竖版**（立绘在上、文字在下），技能只列名字不写描述 | `css/style.css:235` `.general-card{display:flex;flex-direction:column;height:min(64vh,440px)}` |
| 2 | 「← 返回」在**左上角**、字号小，离拇指远 | `index.html:126`、`css/style.css:3177` `.select-back` |
| 3 | 底部只有「确定出战」，没有「换一批」 | `index.html:135-138` |
| 4 | 技能描述被**硬切**（无省略号） | `.gc-skill-descs` 只显示技能名；`#screen-select .gc-skills{max-height:52px}` |
| 5 | 提示文案「悬停技能名可查看描述」在手机无意义 | `js/ui.js:3450`（旧 `updateSelectUI`） |
| 6 | 无长按详情、无换批、无身份牌/目标 | 全缺 |

---

## 三、改法

### 3.1 `index.html`（仅选将区 + 一行 link）

```html
<link rel="stylesheet" href="css/b8g-select.css">   <!-- 紧跟 b5-menu.css -->

<section id="screen-select" class="screen">
  <header class="sel-head">
    <h2 class="sel-title">选择武将</h2>
    <div class="sel-ident">
      <span class="sel-role" id="select-role" data-role="">身份：—</span>
      <span class="sel-goal" id="select-goal"></span>
    </div>
    <div class="sel-hint" id="select-hint">点击卡片选择 · 长按查看完整描述</div>
    <div class="sel-reason" id="select-reason" hidden></div>
  </header>
  <div class="sel-cards">
    <div class="sel-scroll" id="select-scroll"><div class="sel-grid" id="general-row"></div></div>
    <div class="sel-more" id="select-more" hidden>↓ 还有 <b id="select-more-n">0</b> 张</div>
  </div>
  <footer class="sel-foot">
    <button id="btn-select-back" class="btn sel-btn-back">← 返回</button>
    <div class="sel-picked" id="select-picked">已选：—</div>
    <div class="sel-actions">
      <button id="btn-swap-candidates" class="btn sel-btn-swap" disabled>换一批</button>
      <button id="btn-general-confirm" class="btn btn-primary sel-btn-confirm" disabled>确定出战</button>
    </div>
  </footer>
  <div id="select-detail-root"></div>
</section>
```

> `#general-row` 的 id 与 `.general-card` 类都保留：`qa_e2e.js:975+`、`pause_check.js:175` 依赖它们。

### 3.2 `css/b8g-select.css`（新建，全部 `#screen-select` 作用域）

- 骨架：`#screen-select{display:flex;flex-direction:column}`，`.sel-cards{flex:1;min-height:0}` + `.sel-scroll{position:absolute;inset:0;overflow-y:auto}` → **只有卡片区滚动**。
- 列数：`.sel-grid{grid-template-columns:repeat(2,1fr)}`，`@media(min-width:900px)` → 3 列，`@media(max-width:520px)` → 1 列。
- 卡片：`grid-template-columns:clamp(64px,26%,116px) minmax(0,1fr)`，`height:var(--card-h)`（JS 下发）。
- 描述：`.gc-skills{display:-webkit-box;-webkit-line-clamp:var(--desc-lines);overflow:hidden}` + 显式 `max-height:none`（压住 style.css 遗留的 52px）。
- 底栏：`grid-template-columns:auto 1fr auto`，按钮统一 `height:44px`；返回 `min-width:88px`（412 也是 88，不再缩到 76）。
- 浮层：`.sel-detail-mask` 固定遮罩 + `.sd-body{overflow-y:auto}`。
- 短横屏（≤380 / ≤340 高）只压缩字号与间距，**不隐藏目标/提示/称号**（示意图 792×323 是显示的）。

### 3.3 `js/ui.js`（选将段整体重写）

新增/重写（约 3390–3720 行区间）：

| 函数 | 作用 |
|---|---|
| `renderSelect(g)` | 身份牌文案 + `data-role` 上色、胜利目标、提示、reason；候选签名变化时重渲染；末尾补两次 `layoutSelectCards()`（切屏后重算） |
| `generalCardHTML(gen,i,g,me)` | 横向卡 HTML（`class="gcard general-card"`、`data-index`、`--k` 势力色） |
| `renderGeneralCards(req,me)` | 批量渲染 + 触发布局 |
| `layoutSelectCards()` | 读 `gridTemplateColumns` 元素数得列数 → 按可用高度均分 `--card-h`（≥110，≤250）→ 推算 `--desc-lines` → **内联 `!important` 写卡片高度** |
| `updateSelectMore()` | 底部「还有 N 张」显隐与计数 |
| `onGeneralPointerDown/Move` + `clearLongPress` | 长按 450ms 触发详情；移动 >10px 取消；长按后抑制 click 选中 |
| `onGeneralClick` | 点击选中（金色描边） |
| `updateSelectUI()` | 选中态、`已选：X`、确定按钮启用、换批按钮刷新 |
| `refreshSwapButton()` | 调 `canSwapCandidates` 决定置灰；池不足时文案改「无可换武将」、`title` 写原因 |
| `onSwapCandidates()` | 调 `swapCandidates`，成功→清选中/重渲染/淡入动画/480ms 内锁按钮；失败→toast |
| `openSelectDetail/closeSelectDetail/onSelectDetailClick` | 详情浮层 |
| `stripSkillTypePrefix()` | 去掉官方文案开头的「锁定技，/限定技，」等，避免与类型标签重复 |
| `skillTypeTags()` | 锁定技 / 主公技 / 觉醒技 / 限定技 标签 |
| `SEL_GAIN_SKILLS` | 觉醒/限定技获得的新技能映射（志继→观星、凿险→急袭、若愚→激将、魂姿→英姿+英魂、勤学→攻心、潜心→荐言） |

`init()` 增加绑定：`selectRole/selectGoal/selectReason/selectPicked/selectScroll/selectMore/selectMoreN/selectDetailRoot/btnSelectBack/btnSwapCandidates`，以及 `pointerdown/move/up/cancel/leave`、`contextmenu` 屏蔽、浮层点击代理。
`window resize` 里补 `if (screen==='select') layoutSelectCards()`。
导出 `SGS_UI.closeSelectDetail / openSelectDetail / _layoutSelect`。

### 3.4 `js/main.js`（3 行）

返回键：**详情浮层打开时先关浮层**，再按一次才回主菜单。

---

## 四、布局规则与实测

均取 `?screen=select&seed=8&nofx=1`，JPEG q70、`deviceScaleFactor 1`：

| 视口 | 列数 | 卡片尺寸 | 候选 | 完整可见 | 滚动 | 底部提示 | 描述行数 | 三按钮 |
|---|---|---|---|---|---|---|---|---|
| 792×323 | 2 | 379×**110** | 5 | 4 | 是 | ↓ 还有 1 张 | 3 | 88×44 / 96×44 / 112×44 |
| 997×448 | 3 | 318×**148** | 5 | 5 | 否 | — | 5 | 同上 |
| 1280×576 | 3 | 412×**210** | 5 | 5 | 否 | — | 9 | 同上 |
| 1280×800 | 3 | 412×**250** | 5 | 5 | 否 | — | 9 | 同上 |
| 412×915 | 1 | 392×**145** | 5 | 5 | 否 | — | 5 | 88×44 / 84×44 / 104×44 |

- 卡片高度 = `(卡片区可用高 - 8×(行数-1)) / 行数`，夹在 **[110, 250]**。
- 描述行数：**实测**首卡「头部 + 称号 + 内边距」占高后用 `floor(可用 / 行高)` 推导（上限 9）——不同视口字体/行高会变，固定常数会多算一行导致末行被切断（本轮踩过）。
- 所有正文字号 ≥ **12px**（卡片名 15–18、称号/描述/体力/按钮 12–14）。
- 2 件及以上候选时第二行右对齐留白（网格自然排布）。

---

## 五、「换一批」对接

**引擎 API（rules-dev / task-29，契约见 `docs/D8g-换将素材.md`）**

```js
const me = game.players[game.humanSeat];
game.canSwapCandidates(me);   // { ok, reason, per, available } —— 只读，不耗随机数
game.swapCandidates(me);      // { ok, candidates, reason } —— 成功时已更新 game.pendingRequest
```

**UI 行为**

| 场景 | 行为 |
|---|---|
| 初始化 / 每次渲染 | `refreshSwapButton()` 调 `canSwapCandidates`；`!ok` → `disabled` + `title=reason` |
| 池不足（reason=「没有更多可换的武将」） | 按钮置灰，文案「无可换武将」 |
| 点击 | 先 `canSwapCandidates` 预判；失败 toast 原因 |
| 成功 | `pending.req.candidates = res.candidates` → 清 `selectIdx=-1` → `selectSig=''` 强制重渲染 → `.is-swapping` 淡入动画 → **480ms 内 `swapLock=true`**，期间按钮与确定都禁用 |
| 换后 | 「已选：—」、「确定出战」禁用 |
| 无 API（旧引擎） | 按钮保持禁用，toast「当前版本不支持换一批」 |

**实测（997×448, seed=8）**

- 换前：张郃, 周泰, 吕蒙, 黄忠, 贾诩
- 换后：张昭张纮, 夏侯渊, 张角, 周瑜, 陆逊（**零交集**）
- 换后状态：`已选：—`、`确定出战 disabled=true`
- 置灰态（标准包 8 人，per=3，池不足）：`disabled=true`、文案「无可换武将」、`title=没有更多可换的武将`

---

## 六、长按详情

- 触发：卡片 `pointerdown` 450ms；期间移动 >10px 取消；长按后 `lpFired` 抑制随后的 click 选中。
- 内容：势力 / 性别 / 体力 / 武将包 / 称号；每个技能 **名称 + 类型标签 + 完整描述**（不截断，去掉「锁定技，」前缀避免与标签重复）。
- **主公技**：始终显示「仅在你为主公时生效」；当前非主公时该技能 `.is-disabled` 灰显 + 「（当前身份不是主公，该技能不生效）」。
- **觉醒/限定**：附「发动后获得【XX】：<完整描述>」绿色说明块。
- 底部「关闭」「选择此武将」；点遮罩关闭；安卓返回键先关浮层。
- `.sd-body{overflow-y:auto}`，内容超一屏可滚。

**实测**

| 用例 | 结果 |
|---|---|
| 姜维（挑衅 + 志继觉醒技） | 标签「一般技 / 觉醒技」；志继下出现「发动后获得【观星】：准备阶段…」 ✓ |
| 曹操（奸雄 + 护驾主公技），当前为主公 | 标签「一般技 / 主公技」；`is-disabled=0`；注明「仅在你为主公时生效」 ✓ |
| 同上，身份临时改为反贼（测试注入） | 护驾 `is-disabled` ✓；注明「…（当前身份不是主公，该技能不生效）」 ✓ |

---

## 七、踩到的样式雷（style.css 遗留规则）

旧选将样式仍留在 `css/style.css`，与新卡片同名类冲突，已在 `b8g-select.css` 用更高特异性/内联覆盖：

| 位置 | 遗留规则 | 影响 | 处理 |
|---|---|---|---|
| `style.css:3104` / `:3226` | `#screen-select .general-card{height:120px!important;min-height:120px!important}`（手机横屏） | 卡片高度被锁死 120，`--card-h/--desc-lines` 全部失准 | JS 用 **内联 `!important`** 写高度 |
| `style.css:3106` | `#screen-select .gc-skills{max-height:52px}` | 描述被硬切成 3 行且无省略号 | `.sel-grid` 提高特异性 + `max-height:none` |
| `style.css:2740` | `#screen-select .gc-name{…margin-right:48px}` | 名字与性别符号之间空 48px | 重置 `margin:0` |
| `style.css:2735-2736` | `.gc-hp::before{content:"♥"}` / `::after{content:attr(data-hp)}` | 出现**双爱心** | `content:none` |
| `style.css:263` | `.gc-hp{position:absolute;display:flex;gap:3px}` | 体力飘到右上角 | `position:static;display:inline-flex;gap:0` |
| `style.css:2362` | `#screen-select .general-card{height:300px}` 等 | 卡片高度不符 | 同上内联高度 |
| `.gc-skills` flex 子项 | 内容高度参与 flex 基，转头把**称号挤成 0 高** | 792×323 称号消失 | `.gc-head/.gc-title{flex:0 0 auto}` |
| 卡片 grid 行高 | `.gcard` 只有列模板，单行高度按内容收缩 → `.gc-main` 仅 70px，技能框溢出到行外被**横向切断** | 792×323 描述第二行被切半 | `.gcard{grid-template-rows:minmax(0,1fr)}` |

> 这些遗留规则建议 1.0.9 由 B 清理，本轮不动 `style.css`（属 B 写入范围）。

---

## 八、验证

| 项 | 结果 |
|---|---|
| `tools/layout_check.js --scene=select`（新增场景） | 792/997/1280×576/1280×800 视口 **P0=0 P1=0**；断言含：卡片完整可见或可滚、描述有 `-webkit-line-clamp`（不硬切）、文字 ≥12px、三按钮 ≥44 且 `elementFromPoint` 可点、返回 ≥88 |
| `qa_e2e` 选将相关 T10 / T32 | **PASS**（兼容 `.general-card` 后） |
| `tools/pause_check.js` | **28/28 PASS** |
| `tools/ui_probe.js` | 22 PASS / 1 FAIL —— FAIL 项为 `412×915 真实选目标/确认按钮被遮挡`（**对局内操作栏** `.bar-btn.is-primary`），不在选将作用域，未改相关代码，需 B/lead 复核 |
| 控制台 | 截图与探针全程 `pageerror`/`console.error` 均为 0 |

layout_check 新增场景实现于 `tools/layout_check.js`：`runSelectScene()`（约 347 行前），并在 8p 场景列表追加 `'select'`。**只追加，未改动原有对局场景逻辑**。

---

## 九、截图（`out/ui/b8g/`，JPEG q70，全部 waitForIdle）

| 文件 | 内容 |
|---|---|
| `8y_select_792x323.jpg` | 2 列 / 110 高 / 4 可见 + 「还有 1 张」 |
| `8y_select_997x448.jpg` | 3 列 / 5 张全可见 / 5 行描述 |
| `8y_select_1280x576.jpg` | 3 列 / 210 高 |
| `8y_select_1280x800.jpg` | 3 列 / 250 高 |
| `8y_select_412x915.jpg` | 1 列 / 5 张全可见 |
| `8y_select_792x323_ddz.jpg` | 斗地主 3 张候选 |
| `8y_select_selected_997x448.jpg` | 选中态（金边 + 已选：张郃 + 确定可用） |
| `8y_select_detail_997x448.jpg` | 长按详情浮层 |
| `8y_select_swap_997x448.jpg` | 换一批后的新候选（选中已清空） |
| `8y_select_swap_disabled_792x323.jpg` | 换一批置灰态（无可换武将） |

---

## 十、遗留 / 未确认

1. **`ui_probe` 的 412 竖屏 `.bar-btn.is-primary` 遮挡**属对局 HUD，非本轮改动范围，未修。
2. `style.css` 里 6 处选将遗留规则仍在（见 §七），本轮用覆盖方式绕过，**建议后续清理**；清理时需同步删掉 `ui.js` 里为绕过 `!important` 而加的内联写高。
3. 换一批失败时只 toast，未做「按钮旁常驻提示」；当前用置灰 + 文案「无可换武将」表达。
4. 长按 450ms 阈值为经验值，未在真机 Pad 上校准（Chrome 触摸模拟下正常）。
5. 412×915 属网页兼容视口，未在安卓壳内验证。
