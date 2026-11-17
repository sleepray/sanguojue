# sgs-offline 项目说明（Claude Code 每次启动自动读取）

纯离线三国杀：原生 HTML/CSS/JS + Android WebView 壳（../sgs-offline-apk）。当前在做 1.0.7，分支 fix/1.0.7-sweep。

## 开始工作前先读
1. docs/1.0.7-设计决策记录.md：之前讨论定下的所有设计决策和原因（必读，避免推翻已定方案）
2. ../sgs-1.0.7-第四轮提示词.md：当前要执行的任务清单
3. 参照图：docs/手机横屏布局示意v6.png（牌桌布局）、docs/主菜单与比例示意v7.png（主菜单与牌桌比例，冲突时以 v7 为准）；docs/示意图_已作废/ 下的旧图不要参考
4. 历史报告：docs/1.0.7-修复报告.md、docs/1.0.7-第二轮报告.md、docs/1.0.7-第三轮报告.md

## 代码地图
- js/game.js 状态机（judge / dying / tuxi / pickCardFrom / snapshot / restore）
- js/cards.js 卡牌结算
- js/skills.js 武将技能
- js/ai.js AI 决策
- js/ui.js 渲染与弹窗（.seat-role 身份牌、身份标记菜单）
- js/main.js 菜单、存档（sgs.save.v1）、SGS_BACK()、SGS_APP_PAUSE(paused,{keepAudio})
- js/audio.js 音频挂起
- css/style.css（@media 很多且层层覆盖，改样式前先确认实际生效的规则）
- ../sgs-offline-apk/app/src/main/kotlin/io/sanguoduel/offline/MainActivity.kt 原生壳（锁定横屏 sensorLandscape）

## 不可破坏的不变量
1. AI 不透视身份：只有主公和已 revealed 的武将可见；未公开身份在任何界面都不能显示
2. 1v1 只有 1 号位首回合少摸 1 张，标记在 p.duelFirstDraw
3. 后台必须冻结：引擎逻辑 + 倒计时 + 音频全部冻结；回前台不自动解暂停
4. 手动暂停（keepAudio:true）冻结引擎逻辑和倒计时，只保留音乐；恢复后从剩余时间继续
5. 长按看武将详情，单击不出
6. 手牌再点一次取消，无 hover 上移残影
7. 暗手牌选择只显示牌背
8. 五谷结束必须清层
9. 顶部座位（含外挂装备栏）与中央出牌区、动作按钮不重叠
10. 濒死求桃逐人询问，顺序同存活座位

## 工作规则
- 先读代码再下结论，问题要给出 文件:行号；不确定标「待验证」
- 修 bug 先写复现用例（引擎层放 tools/audit_rules.js，页面层放 tools/qa_e2e.js 或 tools/ui_probe.js），确认 FAIL 再修，修完 PASS
- 只改任务清单内的问题，不顺手重构；每批 ≤5 个问题单独 commit
- 牌发生移动（手牌、装备离开）必须走 afterLoseCards / afterCardGain 钩子；判定区移牌不触发连营/枭姬；置入装备区不算「获得牌」
- 截图前必须等动画结束（waitForIdle），文件名与画面内容一致
- 扩大点击热区只能用透明伪元素，不能放大带背景 / 阴影 / backdrop-filter 的元素本身；座位内角标禁止 backdrop-filter / filter
- 所有显示卡名的地方都走卡名归一化函数，页面中不得出现拼音卡名
- 截图用 JPEG q70、deviceScaleFactor 1，只放 out/ui/latest；out/ 不提交

## 验证命令
- 规则回归：node tools/audit_rules.js（无 Chrome 时 T215 SKIP）
- 页面回归：node tools/qa_e2e.js、node tools/ui_probe.js、node tools/pause_check.js
- 布局检测：node tools/layout_check.js [--viewport=997x448] [--scene=...]
- 本地服务：python3 tools/serve.py 8899
- 视口：792×323、915×412、997×448、720×619、1280×800、1376×1032、412×915（最后一个仅网页兼容）
- 发布：python3 tools/build_sw.py → bash tools/package.sh → 升版本号 → ../sgs-offline-apk/build.sh
