# 三国杀 · 单机版

一个完全离线的三国杀单机实现：原生 HTML/CSS/JS，无需安装、无需联网、无需后端。
打开浏览器就能和 AI 打一局身份局。

- 牌堆：标准 108 张 + 军争 52 张（共 160 张）
- 武将：标准 25 名 + 神话再临·风/火/林/山 各 8 名，共 57 名
- 模式：八人身份局、五人身份局、单挑（1v1 面杀练习场）
- 素材：卡牌图 43 张、座位立绘 57 张、大立绘 54 张、音效与武将语音 184 条（整包约 42 MB）
- 节奏：慢 1800ms / 标准 1000ms / 快 550ms 三档；另叠加引擎阶段停顿（出牌 370ms、伤害 450ms、阶段 300–450ms），对照原版出牌动画 0.367s 与 `sys_game_pause`
- 原版对照自查：`docs/原版对照自查.md`

---

## 单挑模式

按原版「1v1 面杀练习场」规则实现：

- 2 人：忠臣（1 号位、先手） vs 反贼（2 号位），率先击败对方获胜。
- 1 号位首轮摸牌 -1；2 号位初始手牌 +1。
- 每人 4 张候选将；独立牌堆：军争牌堆按原版 52 张禁牌表剪裁为 108 张。
- 菜单选「单挑」即可；八人/五人局规则不变。
- 对局顶栏：战报 / 托管 / 投降 / 返回；返回与投降使用页面内确认框。
- 身份标记：点击对手左上角身份徽记循环标记「忠/反/内」，仅自己可见（原版新手引导里的"身份标记"功能）。
- 开局可用手气卡（8/5 人 3 次、1v1 1–2 次）重摸手牌。
- 主菜单可选 AI 难度（简单/普通/困难），透传到所有 AI。
- 方向线金龙按原版等阶控制：默认 0 阶不显示；`GENERAL_GRADATION` 可配置 4 阶开启。
- 1v1 将池可选「经典（原版交集 19 将）」或「全武将（57 将）」。
- 已支持 2v2（4 人）、3v3（6 人）双队与斗地主（3 人，地主 1v2）；人类回合开始自动存档，顶栏「保存」可手动写档，主菜单「继续游戏」读档。
- 出牌倒计时 90s / 响应 45s，超时自动结束出牌或放弃响应；AI 回合座位显示「思考中」。

## 快速开始

**方式一（推荐）：双击启动**

在访达里双击 `启动游戏.command`。脚本会自动切到项目目录、启动本地服务器并打开浏览器。

> 首次双击如果提示"无法打开"，请在文件上右键 → 打开，或先在终端执行一次
> `chmod +x 启动游戏.command`。

**方式二：手动起服务**

```bash
cd sgs-offline
python3 tools/serve.py 8787
# 然后浏览器访问 http://127.0.0.1:8787/
```

> 为什么不能直接双击 `index.html`？因为页面要读取 `assets/audio_index.json`
> 并用相对路径加载音频，浏览器在 `file://` 协议下会拦截这些请求。
> 本地服务器只监听 `127.0.0.1`，不对外网开放。

---

## 玩法

1. **主菜单**选择对局配置：
   - 模式：八人身份局 / 五人身份局
   - 武将包：标准、风、火、林、山（可多选，至少选一个）
   - 牌堆：`标准 + 军争`（160 张）或 `标准`（108 张）
2. 点 **开始游戏** → 在 **选择武将** 界面挑选武将 → **确定出战**。
3. 对局按回合制进行，顶部状态栏会提示当前阶段与需要你做的事：
   - **出牌阶段**：点击手牌使用（可多选目标），或点技能按钮发动技能，完成后点 **结束出牌**。
   - **响应阶段**：需要你打出【闪】【杀】【无懈可击】等牌时，按提示选牌确认。
   - **判定/弃牌**：按提示点击确认即可。
4. **胜利条件**（身份局）：
   - 主公 + 忠臣：消灭所有反贼与内奸
   - 反贼：主公阵亡即获胜
   - 内奸：最后与主公单挑并获胜
5. 右下角 **战报** 可展开战斗日志，**返回** 回到主菜单。
6. 主菜单的 **自动演示** 会让 AI 自动打完一局，适合快速了解流程。

---

## 目录结构

```
sgs-offline/
├── 启动游戏.command        # macOS 双击启动（本地服务器 + 打开浏览器）
├── index.html              # 页面入口
├── css/
│   └── style.css
├── js/
│   ├── data.js             # 牌堆、武将、技能静态数据
│   ├── game.js             # 规则引擎（异步状态机）
│   ├── cards.js            # 卡牌使用与结算
│   ├── skills.js           # 技能实现
│   ├── skilldesc.js        # 技能文案
│   ├── ai.js               # AI 决策
│   └── audio.js            # 音频层（window.SGS_AUDIO）
├── assets/
│   ├── cards/              # 40 张牌面图
│   ├── seat/               # 57 张座位立绘
│   ├── big/                # 54 张大立绘
│   ├── portraits/          # 54 张立绘（与 big 内容相同）
│   ├── audio/              # 184 条音频（见下）
│   │   ├── general/        # 武将技能/阵亡语音
│   │   ├── sfx/            # 界面与牌局音效
│   │   └── bgm/            # 背景音乐
│   └── audio_index.json    # 音频索引（牌名 / 武将 / 类型 → 文件）
├── tools/
│   ├── extract_audio.py    # 从原始 .ab 抽取音频
│   ├── size_report.py      # 体积报告
│   └── package.sh          # 打包脚本
├── out/
│   └── size_report.txt     # 体积报告输出
└── artifacts/              # 打包产物（不进 zip）
```

---

## 音频系统

音频是纯增强层：**任何音频缺失、加载失败或被浏览器拦截，都只会静音，不会报错、不会影响游戏流程。**

### 接口

`js/audio.js` 以普通脚本挂载 `window.SGS_AUDIO`（`index.html` 已引入，位于 `js/main.js` 之前）：

```js
SGS_AUDIO.playCard('sha');            // 出牌音效（'sha' / 'wuxie' / 'tao' …）
SGS_AUDIO.playCard('wuxie');

SGS_AUDIO.playGeneral(1, 'skill');    // 武将技能语音
SGS_AUDIO.playGeneral(1, 'damage');   // 受到伤害
SGS_AUDIO.playGeneral(1, 'death');    // 阵亡

SGS_AUDIO.play('click');              // 内置界面音效
SGS_AUDIO.playBgm('battle');          // 'menu' | 'battle'
SGS_AUDIO.stopBgm();

SGS_AUDIO.enabled = false;            // 总开关（关闭时立即停掉 BGM）
SGS_AUDIO.volume = 0.7;               // 音效音量 0~1
SGS_AUDIO.bgmVolume = 0.35;           // 音乐音量 0~1
```

- 武将 `id` 兼容 `1`、`'1'`、`'001'` 三种写法。
- 索引 `assets/audio_index.json` 懒加载一次；加载不到时会退化为按命名约定
  （`general/general_001_skill1.mp3`）直接尝试播放，因此即使删掉索引也能出声。
- 浏览器要求先有用户交互才能播放，脚本会在首次点击/按键时自动解锁。

### 内置音效

| key | 用途 | 文件 |
| --- | --- | --- |
| `click` | 按钮点击 | `sfx/sfx_click.mp3` |
| `back` | 返回 | `sfx/sfx_back.mp3` |
| `card_play` | 出牌 | `sfx/sfx_card_play.mp3` |
| `card_draw` | 摸牌/发牌 | `sfx/sfx_card_draw.mp3` |
| `card_flip` | 判定翻牌 | `sfx/sfx_card_flip.mp3` |
| `slash` | 【杀】命中/挥砍 | `sfx/sfx_slash.mp3` |
| `kill` | 击杀 | `sfx/sfx_kill.mp3` |
| `damage` | 掉血（也作为受伤语音的通用替代） | `sfx/sfx_damage.mp3` |
| `armor` | 防具触发 | `sfx/sfx_armor.mp3` |
| `game_start` | 开局 | `sfx/sfx_game_start.mp3` |
| `turn_end` | 回合结束 | `sfx/sfx_turn_end.mp3` |
| `win` / `lose` / `draw` | 胜负平 | `sfx/sfx_win.mp3` 等 |

### 命名规则

- 武将语音：`assets/audio/general/general_<三位ID>_<skillN|deathN>.mp3`
  例：`general_001_skill1.mp3`（刘备第 1 个技能）、`general_015_death1.mp3`（曹操阵亡）
- 音效：`assets/audio/sfx/sfx_<key>.mp3`
- 音乐：`assets/audio/bgm/bgm_<key>.mp3`

---

## 体积

由 `python3 tools/size_report.py` 生成，明细见 [`out/size_report.txt`](out/size_report.txt)。

| 目录 | 文件数 | 体积 |
| --- | ---: | ---: |
| `assets/big/` | 54 | 27.72 MB |
| `assets/portraits/` | 54 | 27.72 MB |
| `assets/audio/` | 184 | 9.00 MB |
| `assets/seat/` | 57 | 3.63 MB |
| `assets/cards/` | 40 | 1.18 MB |
| `assets/` 合计 | 394 | **69.34 MB** |
| **可打包体积** | 412 | **69.64 MB** |

判定：目标 **< 100 MB** ✅ 通过；硬上限 **< 200 MB** ✅ 通过。
音频部分共 9.00 MB，占整包约 13%，预算 60 MB，余量充足。

> 可优化项：`assets/portraits/` 与 `assets/big/` 的 54 张图逐字节相同（各 27.7 MB）。
> 若界面只用其中一套，删掉另一套可再省 27.7 MB，整包可降到约 42 MB。

---

## 素材来源与声明

- 卡牌图、立绘、音效均提取自本机已有的客户端资源包：
  `.../sgs_offline/assets/Bundles/`（4665 个 `.ab`），通过
  [UnityPy](https://github.com/K0lb3/UnityPy) 只读解析，**未修改原始资源包**。
- 音效由 AudioClip 内的 FSB5（Vorbis）解码为 WAV，再用 ffmpeg 转成 MP3。
  图片与音频的版权归原权利人所有。
- **本项目仅供个人离线学习与研究使用，不得用于商业用途，不得二次分发素材。**
  如需公开传播，请自行替换为拥有授权的素材。

---

## 重新抽取音频

前提：本机有原始素材包、Python 3（需 UnityPy + pyfmodex/fmod_toolkit）、ffmpeg。

```bash
# 使用素材包自带的虚拟环境（已装好 UnityPy 与 Pillow）
/Users/chenlei/WorkBuddy/2026-10-26-13-50-39/sgs_offline/.venv/bin/python \
  tools/extract_audio.py --with-bgm
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--dry-run` | 只统计将要抽取的条目，不写文件 |
| `--with-bgm` | 额外导出 2 条背景音乐 |
| `--force` | 覆盖已存在文件（默认会重建 `assets/audio/`） |
| `--budget-mb 60` | 音频总体积预算，超限只告警 |

素材包不在默认位置时，可用环境变量指定：

```bash
SGS_AB_DIR=/path/to/assets/Bundles python3 tools/extract_audio.py
```

脚本会：

1. 扫描所有 name 含 `sound` 的 bundle，建立「资源路径 → bundle」索引；
2. 按 `Assets/Res/LocalSoundCDN/spell/<id><拼音>/` 找出 1~57 号武将的
   `skillN_M`（技能）与 `deadN`（阵亡）语音，只取默认皮肤（最小皮肤号）；
3. 抽取白名单音效并转 MP3（22050 Hz 单声道，语音 64 kbps，BGM 96 kbps）；
4. 重新生成 `assets/audio_index.json`（含失败清单与统计）。

---

## 打包

```bash
bash tools/package.sh
```

产出 `artifacts/sgs-offline-<YYYYMMDD>.zip`，自动排除 `out/`、`artifacts/`、
`.venv/`、`node_modules/` 等目录，并打印 zip 体积与文件数。

---

## 已知限制

1. **31 号周泰、32 号张角、33 号于吉没有武将语音。**
   原始素材包的 `spell/` 目录中确实不存在这三名武将的资源，不是抽取失败。
2. **4 号诸葛亮、6 号马超的阵亡语音是损坏资源。**
   两条 AudioClip 声明时长为 109.2 秒、内容为数字静音（峰值约 -48 dB），判定为占位/损坏文件，
   抽取时已跳过，因此这两名武将翻不出阵亡语音。
3. **没有逐张牌的牌名语音。**
   素材包里 `spell/card/` 下 212 条音频全部是 `1.1.1.ogg` 这类数字命名，
   缺少可用的 ID→牌名映射表，无法确认对应关系，因此未强行使用；
   牌面音效统一复用"出牌声"与"挥砍声"两条通用音效。
4. **没有"受伤"语音。** 素材包内武将语音只有技能与阵亡两类，
   `playGeneral(id, 'damage')` 统一使用通用掉血音效。
5. **背景音乐是通用曲目**（`backgroundmusic01/02`），非场景专属 BGM。
6. **音频经过一次有损转码**：FSB5(Vorbis) → WAV → MP3 64 kbps。
   对语音辨识度无影响，但不是无损还原。
7. **未做响度归一化**，不同武将语音音量可能有轻微差异。
8. `assets/portraits/` 与 `assets/big/` 内容重复，见上文"可优化项"。
