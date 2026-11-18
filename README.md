# 三国杀 · 单机版

离线单机三国杀：原生 HTML/CSS/JS Web 版本体 + Android WebView 壳。

**当前版本：1.0.7（2026-11-18）** · 分支 `fix/1.0.7-sweep`

## 特性

- 完全离线，无需后端；浏览器直接运行，或打包为 Android APK（锁定横屏）
- 6 种模式：八人身份局 / 五人身份局 / 单挑 / 2v2 / 3v3 / 斗地主
- 标准 57 名武将 + 可选扩展/变体包；标准 108 张与标准 + 军争 160 张牌堆
- 自动存档 + 3 个手动槽位、「继续游戏 / 读取存档」、旧版存档迁移
- AI 不读取未公开身份/他人手牌/牌堆顺序；有公开行为阵营推断
- 手机横屏 HUD、v7 主菜单、座位外挂装备栏、手牌横向滑动、暂停/后台冻结

完整说明见 [`sgs-offline/README.md`](sgs-offline/README.md)，玩家向更新见 [`docs/1.0.7-发版说明.md`](sgs-offline/docs/1.0.7-发版说明.md)。

## 目录

- `sgs-offline/`：HTML/CSS/JS、武将/技能/卡牌数据、音频与图片素材、测试工具与文档
- `sgs-offline-apk/`：最小 Android WebView 工程，构建时从 `sgs-offline` 同步静态包到 assets
- 构建产物不提交（`sgs-offline/out`、`sgs-offline/artifacts`、Gradle build/cache）

## Web 本地运行

```bash
cd sgs-offline
python3 tools/serve.py 8787
# 打开 http://127.0.0.1:8787/
```

macOS 也可以直接双击 `sgs-offline/启动游戏.command`。

## Android APK

需要 JDK / Android SDK / Gradle；工程默认使用工作区 `.tools` 下的工具链。

```bash
cd sgs-offline-apk
./build.sh
# 输出 sgs-offline-apk/artifacts/sgs-offline.apk
```

当前发布包：`1.0.7-2026.11.18`，约 113 MB；每次构建 SHA-256 会变化，具体值见 [`docs/1.0.7-第六轮报告.md`](sgs-offline/docs/1.0.7-第六轮报告.md)。

## 验证

```bash
cd sgs-offline
node tools/audit_rules.js       # 262/262
node tools/qa_e2e.js            # 58 例：53 PASS / 0 FAIL / 5 SKIP
node tools/ui_probe.js          # 23 PASS
node tools/pause_check.js       # 28/28
node tools/layout_check.js      # 7 视口 0 P0/P1
node tools/ai_vision_check.js   # AI 视野 0 违规
```

## 文档

- [`sgs-offline/docs/1.0.7-设计决策记录.md`](sgs-offline/docs/1.0.7-设计决策记录.md)
- [`sgs-offline/docs/1.0.7-第五轮报告.md`](sgs-offline/docs/1.0.7-第五轮报告.md)
- [`sgs-offline/docs/1.0.7-第六轮报告.md`](sgs-offline/docs/1.0.7-第六轮报告.md)
- [`sgs-offline/docs/1.0.7-发版说明.md`](sgs-offline/docs/1.0.7-发版说明.md)
- [`sgs-offline/docs/手机横屏布局示意v6.png`](sgs-offline/docs/手机横屏布局示意v6.png)、[`主菜单与比例示意v7.png`](sgs-offline/docs/主菜单与比例示意v7.png)

## 说明

音频、立绘、卡图来自本地原版资源包；仓库只用于源码维护，不包含构建产物。素材版权归原权利人所有，仅供个人离线学习与研究，不得商用或二次分发。
