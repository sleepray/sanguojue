# B8g — 1.0.8 收尾第二轮 HUD 修复素材

## 1. 修复表

| 编号 | 现象 | 根因 | 修法 | 验证 |
|---|---|---|---|---|
| 1.1 | 手机横屏 3 个技能第三个被裁 | `css/style.css` 手机横屏 `.human` 高 111px，而 `.skill-btn` 被后续规则抬到 min-height 44px（44×3>111） | `css/b4-hud.css:688` 短横屏强制技能行 30px、list gap2、info 24px；3 行全在玩家区 | 997/720/1067/1280 截图 3 行完整；新增“技能按钮被裁切/中心不可点”检查 0 |
| 1.2 | 1600×720 平板右侧判定区被裁 | 平板技能 2 列占 2 行、装备 2×2 62px、判定 34px，总高超过 human 267px | `b4-hud.css:712` 短高度平板技能 3 列 44px、装备 38px、判定 26px；技能/装备/判定完整 | 1600 截图判定“乐不思蜀/兵粮寸断”完整；新增“平板右侧内容超出玩家区”检查 0 |
| 1.3 | 手机自己判定显示 14px 卡图，看不清 | 平板判定 chip 的 `jd-ico/jd-name` 规则落到手机 | `b4-hud.css:697` 手机 `#me-portrait #me-judges` 恢复 18px 红底单字，隐藏 ico/name；`ui.js:2396` 短横屏才移到头像 | 997/1280/720 截图显示“乐/兵”红字，字号14 |
| 1.4 | 判定浮层压座位/事件文字/玩家区 | `.judge-overlay` 平板 top64%；1600 实测 bottom573 > human top482；事件播报同时显示 | `b4-hud.css:726` 短平板 top49%；`:729` 浮层期间隐藏 skill-banner/flow-float/fx-float；新增判定浮层与座位/玩家区/banner 的相交检查 | 1600/1280/997/1067/1280×800 judge 场景 0 P1；1600 实测 bottom≈465 < human top482 |
| 1.5 | 1280×576 头像贴左边缘 | 放大后 `.human` 第二列仍 34px、`.human-left` 宽仍 76px，95px 头像左溢到 x=3 | `b4-hud.css:631` 玩家区列宽随 scale（76/96/1fr/106）；`:709` 左列宽/内边距同步；实测头像 x=14 | 1280 截图头像左边距 14px；新增 `left<6` 检查 0 |
| 1.6 | 中央牌底部花色压牌名；1600 出牌人成牌顶横条 | `.hc-name` 与 `.hc-suit` 同底；`.pc-src` 继承背景/定位不统一 | `b4-hud.css:733` 中央牌隐藏 `.hc-name`，只保留点数/花色；`.pc-src` 统一 `bottom:calc(100%+4px)`、透明无边框 | 1v1 997/1280/1600 截图底部无牌名重叠，标签在牌上方 |
| 1.7 | 1v1 自己武将名换行压体力 | 放大后 `.pf-name` 允许换行，宽不足 | `b4-hud.css:741` 1v1 名字 12px、nowrap、overflow visible | 997/1280/1600 duel 截图“卧龙诸葛亮”单行；新增截断检查 0 |
| 1.8 | 412×915 顶栏裸数字 | 仅 720 的标签恢复规则媒体条件不含竖屏 | `b4-hud.css:746` 竖屏≤500 保留“牌堆/弃牌/回合”标签+数字 | 412 截图标签可见 |
| 补充 | 响应阶段长按武将详情，动作栏压详情 | `.modal-root z80`/`.general-info-root z85` < action-bar z140 | `b4-hud.css:752` modal 180 / general-info 190，高于 action-bar | 实测 general-info z190、modal z180、bar z140；`elementFromPoint` 命中 modal-foot |

## 2. 判定浮层数据（修复后）
- 1280×576：overlay 204–429，human top433；不压座位（顶座 bottom202）。
- 1600×720：top 49% 后 overlay≈240–465，human top482；顶部座位 bottom233；无相交。
- 1.1/1.2/1.3/1.5/1.7 检查已加入 `tools/layout_check.js`；判定浮层场景检查卡/说明/座位/banner/玩家区。
- 普通截图全部 `waitForIdle`；judge 浮层因1.5s自动关闭，采用日志后700ms捕获再 waitForIdle，截图无 +1/+2 浮字。

## 3. 8y 截图
目录 `out/ui/b8g/`：
- `8y_skills_997x448.jpg`、`8y_skills_720x619.jpg`
- `8y_tablet_1600x720.jpg`
- `8y_avatar_1280x576.jpg`
- `8y_duel_997x448.jpg`、`8y_duel_1280x576.jpg`、`8y_duel_1600x720.jpg`
- `8y_judge_{997x448,1067x480,1280x576,1600x720,1280x800}.png`
- `8y_topbar_412x915.jpg`
- `8y_modal_1280x576.png`
（选将 `8y_select_*` 由选将负责人生成，本文件不覆盖。）

## 4. 10 视口与哈希
- 待全量开/关完成后回填；当前 md5：ui `20d44dbd…`、b4 `fc7c1308…`、style `a4038bc8…`、index `d435fbeb…`。


## 5. 最终 10 视口（2026-11-19，当前最终哈希）

| 视口 | 动画开 P0/P1/P2 | 动画关 P0/P1/P2 |
|---|---|---|
| 792×323 | 0/0/29 | 0/0/29 |
| 915×412 | 0/0/24 | 0/0/24 |
| 997×448 | 0/0/24 | 0/0/24 |
| 1067×480 | 0/0/24 | 0/0/24 |
| 1280×576 | 0/0/17 | 0/0/17 |
| 1600×720 | 0/0/17 | 0/0/17 |
| 720×619 | 0/0/24 | 0/0/24 |
| 1280×800 | 0/0/17 | 0/0/17 |
| 1376×1032 | 0/0/17 | 0/0/17 |
| 412×915 | 0/0/34 | 0/0/34 |

- 开/关均 **0 P0/P1**；P2=225（全部座位内子元素包围盒）。
- 动画开 `/tmp/b8g_full_on3` 与关 `/tmp/b8g_full_off` 日志；报告：
  - `out/ui/latest/layout-report-b8g-on.json`
  - `out/ui/latest/layout-report-b8g-off.json`
- `layout-report.json` 当前为开组。
- waitForIdle timeout residue = 0；开组运行前后 HUD 哈希 UNCHANGED。
- 8y 普通截图全部 waitForIdle；judge 截图因1.5s自动关闭，采用日志后700ms捕获再 waitForIdle，截图无 +1/+2 浮字。

## 6. 最终哈希
- ui.js `75067cad1ef333231ab8ebfbef6998c4`
- b4-hud.css `20d3a80b19519a2ecdb17ca63215abf2`
- style.css `a4038bc8ba59e091c9a02679b3d85cfa`
- index.html `d435fbebfd8c676573845b08b8178975`
- layout_check.js 本文件（含1.1–1.8新增检查）。

## 7. 8y 截图最终索引（out/ui/b8g）
- 技能：`8y_skills_997x448.png`、`8y_skills_720x619.jpg`
- 平板面板：`8y_tablet_1600x720.png`
- 头像边距：`8y_avatar_1280x576.png`
- 1v1：`8y_duel_997x448.jpg`、`8y_duel_1280x576.jpg`、`8y_duel_1600x720.jpg`
- 判定浮层：`8y_judge_{997x448,1067x480,1280x576,1600x720,1280x800}.png`
- 412 顶栏：`8y_topbar_412x915.jpg`
- 弹窗：`8y_modal_1280x576.png`
- （选将 `8y_select_*` 为选将负责人产物，本任务未覆盖。）
