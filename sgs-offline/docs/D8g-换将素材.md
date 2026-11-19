# D8g · 1.0.8 收尾2「换一批」引擎 API 与 audit

范围：任务 1b 引擎部分。只改 `js/game.js`、`tools/audit_rules.js`、新增本文件；未改选将 UI、HUD、AI 平衡。环境 HEAD `b40cb98`。

## 1. API 契约

### 1.1 `game.swapCandidates(player)`

把该人类玩家当前候选整体换成新一批；同步返回新数组，失败不改状态。

```js
const game = SGS_UI._state().game;
const player = game.players[game.humanSeat]; // 仅人类
const res = game.swapCandidates(player);
// res = { ok: true, candidates: [general...], reason: '' }
// 失败 = { ok: false, candidates: 当前候选副本, reason: '…' }
```

规则实现：

- 仅 `player.isHuman === true` 可调用；AI 调用返回 `只有人类玩家可以换一批`。
- 已选定武将（`player.general/secondGeneral`）或被请求玩家不存在 → 失败。
- 旧批放回总池；**新批排除**：其他所有玩家的 `candidates`、已选 `general`/`secondGeneral`、当前这一批。
- 数量保持不变（`player.candidates.length`）；使用 `game.rand()` 逐个抽取，保证同 seed 同一调用序列可复现。
- 将池口径与 `setup()` 一致：
  - 普通身份局：`packs` 勾选包过滤 `availableGenerals()`；
  - 1v1：`new1v1` 用独立新将池；`classic` 在经典池 ≥8 时用 `DUEL_POOL`；其它用全可用将池；
  - 3v3：独立全将池（同 setup）；
  - 斗地主：按 `packs`（setup 同口径），每人 3 候选。
- 主公：当前 `setup()` 没有主公专属候选池（主公仅 +1 体力），换批沿用同一池规则；用例覆盖主公身份调用成功。
- 成功时更新 `game.pendingRequest.candidates`（若 pending 正是该玩家的 `chooseGeneral`），并 `emit()`；返回 `candidates` 是副本，UI 可安全保存。
- 不返回其他玩家候选/身份；新批只含自己的武将。

### 1.2 `game.canSwapCandidates(player)`（UI 置灰用）

只读校验，供选将 UI 初始判断按钮是否置灰：

```js
const info = game.canSwapCandidates(player);
// { ok: true|false, reason: '没有更多可换的武将'|…, per: 当前批量, available: 可抽数量 }
```

`ok:false` 时按钮置灰并显示 `reason`；不会消耗随机数/修改状态。

## 2. 用例（`tools/audit_rules.js`）

| 用例 | 覆盖 | 结果 |
|---|---|---|
| T273 | 新批数量不变、与其他玩家候选/上一批无交集、旧批仍在总池、pending chooseGeneral 同步；连续换 20 次均成功且每次不与上一批/其他候选重叠；同 seed 两局各换 5 次候选 id 序列一致；`canSwapCandidates` 为真 | PASS |
| T274 | 只开标准包 8p：`canSwapCandidates=false` 且 reason=`没有更多可换的武将`、`available=0`；`swapCandidates` 失败且候选不变；AI 调用失败且候选不变 | PASS |
| T275 | 主公身份换批成功（数量 5、与其他候选/旧批无交集）；1v1 经典池换批成功（数量 4、全部在 `DUEL_POOL`、与旧批无交集） | PASS |

实测输出：

- T273：`canSwap=true；新批=5；与其他候选无交集=true；与上一批无交集=true；旧批仍在池=true；pending同步=true；20连换=20；同seed序列一致=true`
- T274：`标准包8p：can=false/没有更多可换的武将 available=0；swap ok=false 状态不变=true；AI：ok=false/只有人类玩家可以换一批 状态不变=true`
- T275：`主公：ok=true 数量=5；1v1：ok=true 数量=4 均为经典池=true`

## 3. 回归数字

- `node tools/audit_rules.js`：原 **268/268** → 新增 T273–T275 后 **271/271 PASS**。
- `node tools/ai_vision_check.js 50`：8p/5p/3v3/ddz/1v1 各 50 局 = **250 局 / 10051 回合 / 0 违规 / 0 错误**。
- `node --check js/game.js`、`node --check tools/audit_rules.js` 通过。

## 4. 给选将 UI（visual-audit/select-ui）的接入说明

1. 渲染选将页时取 `game = SGS_UI._state().game; me = game.players[game.humanSeat];`
2. 按钮置灰：`const info = game.canSwapCandidates(me);`，`!info.ok` 时 disabled，title/toast 用 `info.reason`；否则可点。
3. 点击（动画期间防连点由 UI 自己控制）：
   ```js
   const res = game.swapCandidates(me);
   if (res.ok) {
     // req = UI 当前的 pending.req
     req.candidates = res.candidates; // 引擎已同步 game.pendingRequest，但 UI 自己的 req 也更新
     // 清空已选卡：selectIdx=-1/重渲染；播换卡动画
   } else {
     toast(res.reason);
   }
   ```
4. 换批后不会改变其他玩家候选/身份，也不会改变 AI 的候选与决策；同 seed 的“换批次数序列”决定结果，动画/点击间隔不影响 RNG。
5. 主公/1v1/3v3/斗地主均复用同一 API；候选数量取当前 `me.candidates.length`，不是固定 5。

## 5. 无法自动化/边界

- 置灰按钮、换卡动画、已选卡清空、“动画期间不可连点”属于选将 UI，由 select-ui 负责；引擎提供 `canSwapCandidates` 与同步后的 `pendingRequest.candidates`。
- 斗地主地主第二武将（`ddzPickSecondGeneral`）走的是另一条 `chooseGeneral` 请求（池为全将排除已选），本任务不改变该流程，也未把它接入“换一批”（避免影响地主双将规则）。
- 主公专属候选池：当前版本没有独立主公池，已按现有 setup 规则核实；若以后新增主公池，需在 `candidatePool()` 中同步。
- 同 seed 可复现性要求“相同的换批调用序列”；不同 UI 点击次数/动画不会改变 RNG，但会改变序列。
