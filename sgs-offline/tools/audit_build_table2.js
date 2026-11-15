/* 依据当前冻结快照生成 99 行审计总表 */
const fs = require('fs');
require('../js/skilldesc.js');require('../js/data.js');
const D = globalThis.SGS_DATA;
const nameToId = {};
for (const id of Object.keys(D.SKILLS)) nameToId[D.SKILLS[id].name] = id;
const lines = require('/tmp/skill_lines.json');
const oldRows = fs.readFileSync('/tmp/skill_table.md', 'utf8').split('\n').filter(l => /^\|\s*\d+\s*\|/.test(l));
const byName = {};
for (const l of oldRows) { const c = l.split('|').map(s => s.trim()); byName[c[2]] = { owner: c[3], gap: c[5] }; }
const simplify = new Set(['jijiang','wusheng','qicai','kongcheng','liuli','jijiu','lijian','jianxiong','guicai','luoshen','shensu','jushou','leiji','guidao','jieming','huoji','duanliang','songwei','yinghun','juxiang','luanwu','dimeng','zaoxian','zhiji','fangquan','jiang','zhijian','guzheng','huashen','tianyi','beige','hongyan']);
const mismatch = new Set(['huangtian','zhiba','qiaobian']);
const unimplemented = new Set(['guhuo','xinsheng']);
const gapOverride = {
  shensu: '只有模式1（跳过判定+摸牌）；没有“跳过出牌阶段并弃一张装备”的模式2',
  jushou: '结束阶段自动摸3并翻面，不询问是否发动（官方为可选）',
  huashen: '替换动作无 build 入口，实际不可达；只取化身牌第一个技能；无性别/势力变化',
  tianyi: '赢后次数+1与无距离已生效；仍缺“可以多指定一个目标”',
  beige: '触发者/判定对象已修正；梅花分支由系统随机弃伤害来源两张手牌（官方由来源选择）',
  hongyan: '只在判定时把黑桃视为红桃；手牌/装备区黑桃未改花色',
  huangtian: 'useSkillAction 有分支，但 buildSkillActions 无入口，实际不可达；官方为其他群势力出牌阶段限一次交给张角',
  zhiba: '仅剩孙策主动拼点分支，buildSkillActions 无入口；官方应由其他吴势力角色发起，孙策魂姿后可拒绝',
  qiaobian: 'useSkillAction 有分支，但 buildSkillActions 无入口，实际不可达；且“移动场上一张牌”实现为弃置',
  guhuo: '零引用；AI 仅把于吉列为不选',
  xinsheng: '零引用；与化身无联动',
};
const evOverride = {
  xingshang: 'js/game.js:852；js/skills.js:583-594',
  hongyan: 'js/game.js:543',
  beige: 'js/game.js:749-770',
  kuanggu: 'js/game.js:743-746',
  buqu: 'js/game.js:797-816',
  niepan: 'js/game.js:780-798',
  zaiqi: 'js/skills.js:525-540',
  haoshi: 'js/skills.js:459-483',
  tuntian: 'js/skills.js:557-568；js/game.js:926',
  tiaoxin: 'js/skills.js:130-132',
  kanpo: 'js/cards.js:354,361',
  shensu: 'js/skills.js:332,450-470',
  jushou: 'js/skills.js:552',
  jieming: 'js/skills.js:226-235',
  huashen: 'js/skills.js:147,355,481',
  zaoxian: 'js/skills.js:451',
  zhiba: 'js/skills.js:361-368（无 build 入口）',
  huangtian: 'js/skills.js:379-386（无 build 入口）',
  qiaobian: 'js/skills.js:388-414（无 build 入口）',
  guhuo: 'js/ai.js:88；js/skills.js 无 guhuo',
  xinsheng: '无引用',
  duanliang: 'js/cards.js:20,154-159',
  qicai: 'js/cards.js:143,155',
  luoshen: 'js/skills.js:55-74',
  jijiu: 'js/cards.js:802',
  wusheng: 'js/cards.js:14,765',
  dimeng: 'js/skills.js:341-356',
  luanwu: 'js/skills.js:315-325',
  tianyi: 'js/skills.js:264-269；js/cards.js:96,115-132',
};
function ev(id) {
  if (evOverride[id]) return evOverride[id];
  const h = lines[id] || {};
  const pick = (f) => (h[f] || []).slice(0, 3).join(',');
  const parts = [];
  if (pick('skills.js')) parts.push('js/skills.js:' + pick('skills.js'));
  if (pick('cards.js')) parts.push('js/cards.js:' + pick('cards.js'));
  if (pick('game.js')) parts.push('js/game.js:' + pick('game.js'));
  return parts.join('；') || '—';
}
const rows = [];
for (const l of oldRows) {
  const c = l.split('|').map(s => s.trim());
  const name = c[2], owner = c[3];
  const id = nameToId[name] || name;
  let status = '完整';
  if (simplify.has(id)) status = '简化';
  else if (mismatch.has(id)) status = '不符';
  else if (unimplemented.has(id)) status = '未实现';
  let gap = status === '完整' ? '—' : (gapOverride[id] || byName[name].gap);
  rows.push([name, owner, status, gap, ev(id)]);
}
const stat = { 完整: 0, 简化: 0, 不符: 0, 未实现: 0 };
for (const r of rows) stat[r[2]]++;
const md = ['| # | 技能 | 武将 | 状态 | 缺口 / 行为差异 | 证据（当前快照文件:行） |', '|---:|---|---|---|---|---|'];
rows.forEach((r, i) => md.push(`| ${i + 1} | ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} | ${r[4]} |`));
fs.writeFileSync('/tmp/skill_table2.md', md.join('\n') + '\n');
console.log('rows', rows.length, JSON.stringify(stat));
