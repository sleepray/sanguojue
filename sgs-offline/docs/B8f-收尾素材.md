# B8f 1.0.8 收尾：测试数据核对 + 回归

分支 `fix/1.0.8-balance`，HEAD `3f620ef`。

## 任务 3：卧龙诸葛亮 + 蛊惑

**结论：测试数据注入，不是产品 bug。**

- `tools/layout_check.js:381-390` 为“最长武将名 + 最长技能描述”分别取最长值：
  - `longName()` 从 `GENERALS` 取最长名字 → 卧龙诸葛亮
  - `longSkill` 从 `SKILLS` 取 `desc` 最长 → 蛊惑（于吉）
  - 然后 `p.general.name = longName()`，`p.general.skills = [longSkill]`，把两个不同武将的名字/技能拼在同一个 synthetic player 上。
- `js/data.js:226` 卧龙诸葛亮真实技能为 `['bazhen','huoji','kanpo']`（八阵/火计/看破）；正常开局 UI 不会出现该组合。
- 产品数据一致性：遍历 `SGS_DATA.GENERALS`（87 名，含变体扩展）与 `SKILLS`，共 157 个技能引用，缺失 0；卧龙诸葛亮映射为 八阵/火计/看破。

**建议 A 修 layout_check**：`p.general.name='卧龙诸葛亮'; p.general.skills=['bazhen','huoji','kanpo'];`；最长技能描述另选真实武将单独测，不要跨武将拼。文件不在 B 的写入范围，已发 A/Lead。

## 任务 4：回归（待 A/C 完成后执行）

计划命令：
- `node tools/audit_rules.js`
- `QA_DEEP_COUNTDOWN=1 node tools/qa_e2e.js`
- `node tools/ui_probe.js --viewport 997x448`
- `node tools/pause_check.js`
- `node tools/ai_vision_check.js`
- `node tools/layout_check.js` 与 `--anim=off --no-rotate`（10 视口）
- T32/T36/T53/T56 定向稳定性

结果待填。
