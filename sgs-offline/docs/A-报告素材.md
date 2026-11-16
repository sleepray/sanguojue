# A — 移动端/平板 UI 布局检查素材（1.0.7）

## 1. 最终状态

- 工具：`tools/layout_check.js`（puppeteer-core + 本机 Chrome，不下载 Chromium）
- 视口：323×792、412×915、619×720、800×1280、1280×800，deviceScaleFactor=1
- 最终结果：**5 视口全部 P0=0 / P1=0**
- P2（记录不修）：**1268** 条（去重后；raw 5153）
- 规则基线：`node tools/audit_rules.js` → **PASS 213/213**
- 截图：`out/ui/latest/full_<视口>.jpg`（每视口 1 张，JPEG q70）；本轮无 P0/P1，故无问题元素 clip。
- 机器可读报告：`out/ui/latest/layout-report.json`

| 视口 | P0 | P1 | P2 | 场景数 |
|---|---:|---:|---:|---:|
| 323×792 | 0 | 0 | 260 | 34 |
| 412×915 | 0 | 0 | 260 | 34 |
| 619×720 | 0 | 0 | 252 | 34 |
| 800×1280 | 0 | 0 | 252 | 34 |
| 1280×800 | 0 | 0 | 244 | 34 |

## 2. 复跑命令

```bash
cd sgs-offline
node tools/layout_check.js                       # 最终全量：5 视口/34 场景/截图/汇总
node tools/layout_check.js --explain             # 输出去重后的 P0/P1 明细
node tools/layout_check.js --viewport=619x720 --scene=play5,target
node tools/layout_check.js --viewport=800x1280 --scene=hidden,intro,skilldesc,log,settings,pause
```

- `--viewport` 支持 5 个 id；`--scene` 支持 `all` 或逗号列表。
- 增量运行会把当前视口结果合并回 `layout-report.json`，不会覆盖其它视口。
- 全量运行前 `latest` 改名为 `prev`，更早的 `prev` 删除；只保留两轮。
- `out/.chrome-profile` 固定复用，结束后清理（Chrome 占用时允许保留，不影响结果）。

## 3. 问题表（P0/P1 已清零，P2 记录）

| 级别 | 类型 | 视口 | 场景 | 选择器/范围 | 测量数据 | 截图 | 状态 |
|---|---|---|---|---|---|---|---|
| P0/P1 | 布局/遮挡 | 323/412/619/800/1280 | 全场景 | — | P0=0，P1=0 | `full_<vp>.jpg` | **已清零** |
| P2 | cover 裁切待验证 | 全部 | 全场景 | `img[object-fit=cover]` | 300 条去重；关键内容裁切需人工判断 | — | 记录不修 |
| P2 | 文字压图对比度待验证 | 全部 | 全场景 | 文本叶子压图片/背景 | 831 条去重；未做像素级采样 | — | 记录不修/待人工确认 |
| P2 | 座位内子元素重叠 | 全部 | 全场景 | 如 `.seat-hand`×`.seat-hp`、`.seat-name`×`.seat-equip-list` | 127 条去重；多为紧凑座位角标叠放 | — | 记录不修 |
| P2 | 字号<12 | 全部 | 全场景 | 如卡牌小字/角标 | 5 条去重 | — | 记录不修 |
| P2 | 动画/浮层残留 | 全部 | 全场景 | `pointer-events` 可见浮层 | 5 条去重 | — | 记录不修 |

> P2 证据在 `layout-report.json` 的 `issues` 中，字段含 selector/measure/scenes/count；本轮按资源约束不逐条截图。

## 4. 工具假阳性剔除（重要）

旧版/未过滤结果（Lead 看到的 1129/1100/986/942/922 P1）主要是：
- modal / general-info / settings / log / pause 打开时，仍对**背景座位、手牌、按钮**做 elementFromPoint；
- wugu/judge/pindian 等 `pointer-events:none` 展示浮层，按矩形四角误判；
- `.log-panel` 顶部被顶栏压住（抽屉从 top:52 开始）按矩形误判；
- 同一选择器在多个弹窗场景重复计数。

现行过滤规则：
1. 顶层上下文判定：`.resume-overlay.is-on` / `.modal-mask` / `.settings-panel.is-open` / `.log-panel.is-open` / 五谷/判定/拼点/救援/亮牌浮层。
   - modal：只查 `.modal` 内部；
   - drawer：只查 `.settings-panel/.log-panel`；
   - pause：只查 `.resume-overlay`；
   - overlay：只查浮层自身以及手牌/按钮/顶栏，不查背景座位。
2. `pointer-events:none` 的展示浮层不参与遮挡判定（elementFromPoint 必然穿透）。
3. 浮层容器有透明/圆角边角，只检查中心，不检查四角；浮层内部卡牌/按钮仍检查中心+四角。
4. 手牌扇形叠压（`.hand-card` 互相压住）属于设计，放行。
5. 报告按 `level|type|viewport|selector` 去重，附 `scenes/count/measures`；同一问题不再按场景重复计数。

假阳性剔除前后：
- 旧全量：P1 = 323:**1129** / 412:**1100** / 619:**986** / 800:**942** / 1280:**922**
- 最终全量：P1 = **0 / 0 / 0 / 0 / 0**
- 单测模态场景（800×1280：hidden/intro/skilldesc/log/settings/pause）过滤后 P1=0；过滤前 raw 88 条（重复 P2/背景遮挡）。

## 5. 覆盖清单

- **8人、3v3（全场景）**：play1、play5、play10、play15、target、wugu、rescue、pindian、hidden、judge、intro、skilldesc、log、settings、pause（每视口各 15 个场景 × 2 模式）。
- **1v1、5p**：play5、target（每视口各 2 场景）。
- 状态：
  - 手牌 1/5/10/15；
  - 玩家 0 装备满 4 件（青釭剑/八卦阵/赤兔/的卢）；
  - 判定区 2 张（乐不思蜀、兵粮寸断）；
  - 最长武将名（数据取最长：卧龙诸葛亮）；
  - 最长技能描述（数据按 desc 长度取：义绝 103 字）。
- 界面：出牌、选目标、五谷、求桃、拼点、暗手牌选择、判定、长按介绍、技能描述（general-info modal）、战斗日志、设置/暂停。
- 无法完全真实构造的：
  - rescue/pindian 使用 `g.recent.push({kind:'rescue'|'pindian'})` 驱动既有 UI（不执行真实求桃/拼点结算）；
  - hidden 使用 `SGS_UI.request({type:'chooseHiddenCard'})` 驱动既有弹窗；
  - 上述注入只改测试页面状态，不改产品逻辑。

## 6. 白名单（`tools/layout_whitelist.json`）

| 父元素 | 子元素 A | 子元素 B | 理由 |
|---|---|---|---|
| `.seat` | `.seat-art` | `*` | 武将底图与势力/身份/手牌/血量/装备角标按原版分层叠放 |
| `.seat` | `.seat-veil` | `*` | 座位暗化渐变遮罩覆盖底图 |
| `.seat` | `.seat-frame` | `*` | 座位描边框覆盖底图与状态角标 |

> 当前 P2 中 `.seat-hand`×`.seat-hp`、`.seat-name`×`.seat-equip-list` 等尚未加入白名单，作为 P2 记录，待主控确认是否属于合理叠放。

## 7. 修复清单（文件:行）

| 文件:行 | 改动 | 解决问题 | 验证 |
|---|---|---|---|
| `js/ui.js:35` | `POS_8_P` 侧座 y 45→52 | 323/412 8p 侧座与顶排角点遮挡 | 5 视口 play/target 0 P1 |
| `js/ui.js:38` | `POS_6_P` 顶排 x 26/50/74→25/50/75 | 323 3v3 顶排 2px 水平重叠 | 323/412 全场景 0 P1 |
| `js/ui.js:2946-2953` | `renderPickBar` 增加 `body.is-table-pick` | 选目标时临时替换顶栏，避免 pickbar 压座位 | 619/1280 target 0 P1 |
| `css/style.css:3615` | `.tb-btn { flex:0 0 auto; white-space:nowrap }` | 619 顶栏“设置/战报”换行 | 619 全场景 0 P1 |
| `css/style.css:3617-3624` | 619×720 短方屏 human 300 / 手牌 76×100 | 手牌高 113 被 human 裁切 | 619 play5/target 0 P1 |
| `css/style.css:3626-3640` | 窄屏 pick-bar 压缩/下移 | 323/412 选目标条压座位 | play/target 0 P1 |
| `css/style.css:3642-3653` | pick-bar 单行 30px | 避免条内换行撑高 | 5 视口 0 P1 |
| `css/style.css:3655-3658` | 761–1280 短横屏底栏 290px | 1280 human scrollHeight 288>263 截断 | 1280 全场景 0 P1 |
| `css/style.css:3660-3664` | pick-bar top4 + 隐藏 topbar | 选目标条不再盖顶排座位 | 5 视口 0 P1 |
| `tools/layout_check.js` | 5 视口/34 场景/顶层过滤/去重/JPEG 截图 | 可复跑布局验收 | 本轮 0 P0/P1 |

## 8. 截图

- `out/ui/latest/full_323x792.jpg`
- `out/ui/latest/full_412x915.jpg`
- `out/ui/latest/full_619x720.jpg`
- `out/ui/latest/full_800x1280.jpg`
- `out/ui/latest/full_1280x800.jpg`
- 旧轮次：`out/ui/prev/`（仅保留两轮）；本轮无 P0/P1 问题元素 clip。

## 9. 剩余/需确认

1. **safe-area 探针能力缺失**：Chrome 157 不支持 `Emulation.setSafeAreaInsets`；5 个视口 notes 已记录“unsupported”。CSS 的 `env(safe-area-inset-*)` 留白无法在 headless 精确模拟，需真机复核。
2. **P2 未修**：cover 裁切 300、文字压图对比度待验证 831、座位内子元素重叠 127、字号<12 5、动画/浮层残留 5。
3. **rescue/pindian/hidden 为页面状态注入**，不是真实结算；已如实标注。
4. 本轮 A 未修改 `index.html`、`js/game.js|cards.js|skills.js|ai.js`、Kotlin、APK。
