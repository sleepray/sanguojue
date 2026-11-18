# 三国杀 · 单机版

一个完全离线的三国杀单机实现：原生 HTML/CSS/JS，无需联网、无需后端；同一套代码通过 Android WebView 壳打包为 APK。

- **当前版本：1.0.7**（2026-11-18，分支 `fix/1.0.7-sweep`）
- 牌堆：标准 108 张、标准 + 军争 160 张
- 武将：标准 57 名；可另选扩展武将/变体包
- 模式：八人身份局、五人身份局、单挑（1v1）、2v2、3v3、斗地主
- 素材：卡图、座位立绘、大立绘、音效与武将语音（约 42 MB）
- 开源方式：纯静态源码；构建产物、截图、测试输出不提交

> 本项目仅供个人离线学习与研究使用。卡图、立绘、音频版权归原权利人所有，不得商用或二次分发素材；公开传播请自行替换为有授权的素材。

---

## 1.0.7 主要变化

- **自动存档 + 3 个手动槽位**：每回合开始自动保存；「更多 → 保存」保存本回合开始进度；主菜单「继续游戏 / 读取存档」可读档、删除、覆盖。旧版单槽存档会自动迁移。
- **主菜单重排**：模式 3×2、武将包标签、牌堆标签、单挑将池、高级设置摘要；右栏开始/继续/读取/自动演示，按钮内直接显示当前设置或存档摘要。
- **手机横屏布局**：底部玩家区控制在视口 35% 以内；座位外挂装备栏、判定单字、身份/手牌数/体力重排；中央打出牌与手牌同款牌面；15 张手牌可横向滑动。
- **AI 不透视**：只使用公开信息（身份可见性、手牌数量、公开行为）；新增公开行为阵营推断与视野自动审计。
- **规则与体验修复**：装备/判定区移牌钩子、1v1 先手摸牌、无懈询问时序、暂停/后台冻结、身份标记随存档保留等。

完整变更见 [`docs/1.0.7-第五轮报告.md`](docs/1.0.7-第五轮报告.md) 与 [`docs/1.0.7-第六轮报告.md`](docs/1.0.7-第六轮报告.md)；玩家向说明见 [`docs/1.0.7-发版说明.md`](docs/1.0.7-发版说明.md)。

---

## 模式

| 模式 | 人数 | 说明 |
|---|---:|---|
| 八人身份局 | 8 | 主忠反内，标准身份局 |
| 五人身份局 | 5 | 主公/忠臣/反贼/内奸 |
| 单挑 | 2 | 1v1 面杀练习场；1 号位首回合少摸 1 张，可选经典/全武将将池 |
| 2v2 | 4 | 双队对抗 |
| 3v3 | 6 | 双队对抗，含暖主/冷主等站位与选将流程 |
| 斗地主 | 3 | 地主 1v2，含专属牌与技能 |

可选牌堆：标准 · 108 张（首次默认）/ 标准 + 军争 · 160 张。  
可选武将包：标准 / 风 / 火 / 林 / 山 / 变体扩展。

---

## 快速开始

### 方式一：macOS 双击启动

在访达中双击 `启动游戏.command`。脚本会启动本地服务器（默认 8787）并打开浏览器。

> 首次双击若提示「无法打开」，请右键 → 打开，或先执行一次
> `chmod +x 启动游戏.command`。

### 方式二：手动启动

```bash
cd sgs-offline
python3 tools/serve.py 8787
# 浏览器访问 http://127.0.0.1:8787/
```

> 不能直接双击 `index.html`：页面需要读取 `assets/audio_index.json` 并用相对路径加载音频，`file://` 下会被浏览器拦截。服务器只监听 `127.0.0.1`。

### 方式三：Android APK

```bash
cd sgs-offline-apk
./build.sh
# 输出 sgs-offline-apk/artifacts/sgs-offline.apk
```

APK 锁定横屏（`sensorLandscape`）。当前发布包：`1.0.7-2026.11.18`，约 113 MB，SHA-256 见第六轮报告；每次构建哈希会变化。

---

## 玩法与界面

1. 主菜单选择模式、武将包、牌堆；「开始游戏」按钮内显示当前设置摘要。
2. 有存档时「继续游戏」直接回到自动存档，「读取存档」可管理自动档与 3 个手动槽。
3. 选将：每人 4 张候选（1v1 可选经典/全武将池），点击确认后开局。
4. 对局顶栏：牌堆 / 弃牌 / 回合；中间阶段或询问提示；右侧「暂停 / 战报 / 更多」。
5. 「更多」菜单包含设置、托管、保存；投降与退出在分隔线下，均二次确认。
6. 出牌阶段可点手牌选中、再点座位选目标；再点一次手牌取消；长按头像看武将详情。
7. 出牌倒计时 90s、响应 45s；读秒显示在主按钮与手牌上沿进度条。
8. 自动演示可让 AI 快速打完一局；演示不读写玩家存档。

身份标记：点击其他玩家身份牌循环「忠 / 反 / 内」，仅自己可见；标记会写入存档信封，读档后恢复，不会泄露真实身份。

---

## 目录结构

```
sgs-offline/
├── 启动游戏.command       # macOS 双击启动
├── index.html             # 页面入口（主菜单 + 对局 + 弹窗）
├── css/
│   ├── style.css          # 基础样式与响应式
│   ├── ui-107.css         # 1.0.7 桌面/平板补充
│   ├── b4-hud.css         # 手机横屏 HUD
│   ├── b5-menu.css        # v7 主菜单
│   └── save-107.css       # 存档面板
├── js/
│   ├── data.js            # 牌堆、武将、技能静态数据
│   ├── game.js            # 规则引擎（异步状态机、snapshot/restore）
│   ├── cards.js           # 卡牌结算
│   ├── skills.js          # 技能实现
│   ├── skilldesc.js       # 技能文案
│   ├── ai.js              # AI 决策与公开行为推断
│   ├── ui.js              # 渲染、弹窗、牌面组件
│   ├── main.js            # 菜单、存档、SGS_BACK、后台暂停
│   └── audio.js           # 音频层（window.SGS_AUDIO）
├── assets/                # 卡图、立绘、座位图、音频、audio_index.json
├── tools/                 # 服务器、打包、审计、E2E、布局检测
├── docs/                  # 设计决策、各轮报告、发版说明、布局参照图
└── artifacts/             # Web/APK 构建产物（不提交）
```

---

## 验证与回归

```bash
cd sgs-offline
python3 tools/serve.py 8899          # 测试服务（E2E 默认连 8899）

node tools/audit_rules.js            # 规则回归（无 Chrome 时 T215 SKIP）
node tools/qa_e2e.js                 # 页面 E2E（约 18 分钟）
node tools/ui_probe.js               # 交互/暂停/静音/求桃等
node tools/pause_check.js            # 暂停冻结
node tools/ai_vision_check.js        # AI 视野 Proxy 审计
node tools/layout_check.js           # 7 视口布局检测
```

当前基线（1.0.7）：audit `262/262`；qa_e2e `58 例 / 53 PASS / 0 FAIL / 5 SKIP`；layout 7 视口动画开/关均 0 P0/P1；ui_probe 23 PASS；pause 28/28；AI 视野 250 局 0 违规。

---

## 文档

- [`docs/1.0.7-设计决策记录.md`](docs/1.0.7-设计决策记录.md)：已定方案与经验教训
- [`docs/1.0.7-发版说明.md`](docs/1.0.7-发版说明.md)：面向玩家的更新说明
- [`docs/1.0.7-第五轮报告.md`](docs/1.0.7-第五轮报告.md)、[`docs/1.0.7-第六轮报告.md`](docs/1.0.7-第六轮报告.md)：修复、AI 平衡、APK 信息
- [`docs/手机横屏布局示意v6.png`](docs/手机横屏布局示意v6.png)：牌桌参照图
- [`docs/主菜单与比例示意v7.png`](docs/主菜单与比例示意v7.png)：主菜单与牌桌比例参照图
- [`docs/UI排布规范.md`](docs/UI排布规范.md)：布局规范

---

## 音频系统

音频是纯增强层：缺失、加载失败或被浏览器拦截只会静音，不影响游戏流程。

```js
SGS_AUDIO.playCard('sha');            // 出牌音效
SGS_AUDIO.playGeneral(1, 'skill');    // 武将技能语音
SGS_AUDIO.playGeneral(1, 'death');    // 阵亡
SGS_AUDIO.play('click');              // 界面音效
SGS_AUDIO.playBgm('battle');          // 'menu' | 'battle'
SGS_AUDIO.enabled = false;            // 总开关（立即停 BGM）
SGS_AUDIO.volume = 0.7;               // 音效音量
SGS_AUDIO.bgmVolume = 0.35;           // 音乐音量
```

- 武将 `id` 兼容 `1`、`'1'`、`'001'`。
- 索引 `assets/audio_index.json` 懒加载；加载不到时按命名约定直接尝试播放。
- 浏览器要求用户交互后才能出声，首次点击/按键自动解锁。
- 设置里的静音开关会记住状态，静音后切后台再回来不会自动恢复声音。

内置音效：`click`、`back`、`card_play`、`card_draw`、`card_flip`、`slash`、`kill`、`damage`、`armor`、`game_start`、`turn_end`、`win`/`lose`/`draw`。

命名规则：`general/general_<三位ID>_<skillN|deathN>.mp3`、`sfx/sfx_<key>.mp3`、`bgm/bgm_<key>.mp3`。

---

## 打包与发布

```bash
cd sgs-offline
python3 tools/build_sw.py       # 生成/更新 sw.js 缓存清单
bash tools/package.sh           # 产出 artifacts/sgs-offline-YYYYMMDD.zip

cd ../sgs-offline-apk
./build.sh                      # 产出 artifacts/sgs-offline.apk
```

`package.sh` 自动排除 `out/`、`artifacts/`、`.venv/`、`node_modules/` 等目录。APK 构建会把 `sgs-offline` 静态包同步进 assets。

---

## 素材来源与声明

- 卡图、立绘、音效提取自本机已有的客户端资源包（UnityPy 只读解析，未修改原始包）；音效由 FSB5(Vorbis) 解码后转 MP3。
- 图片与音频版权归原权利人所有。
- **仅供个人离线学习与研究使用，不得商用，不得二次分发素材。**

---

## 已知限制

1. 周泰、张角、于吉没有武将语音；诸葛亮、马超的阵亡语音是损坏资源，已跳过。
2. 没有逐张牌的牌名语音；受伤语音统一用通用掉血音效；BGM 为通用曲目。
3. 音频经过一次有损转码，未做响度归一化；`assets/portraits/` 与 `assets/big/` 内容重复。
4. 手气卡（mulligan）功能暂时停用。
5. 792×323 这类很矮的屏幕上，15 张手牌需要横向滑动才能看到最后几张。
6. 刘海/挖孔屏 safe-area 仍需真机确认；模拟器不能完全代表真机。
7. 身份标记只在读档时恢复；直接刷新页面且不读档会清空。
8. 纯 AI 对战中内奸胜率仍偏低，属于后续平衡问题。
