/* 只读审计脚本：统计每个技能 id 在实现文件中的引用（含行号），不改引擎 */
const fs = require('fs');
const path = require('path');
const base = path.join(__dirname, '..', 'js');
require(path.join(base, 'skilldesc.js'));
require(path.join(base, 'data.js'));
const D = globalThis.SGS_DATA;

const files = ['skills.js', 'cards.js', 'game.js', 'ai.js'];
const lines = {};
for (const f of files) lines[f] = fs.readFileSync(path.join(base, f), 'utf8').split('\n');

const allSkills = new Map();
for (const g of D.GENERALS) for (const s of g.skills) allSkills.set(s, (allSkills.get(s) || []).concat(g.name));
// 追加实现中动态授予的技能
const dynamic = ['jixi', 'guanxing', 'yingzi', 'yinghun', 'jijiang'];
for (const s of dynamic) if (!allSkills.has(s)) allSkills.set(s, ['(动态授予)']);

const rows = [];
for (const [sid, owners] of allSkills) {
  const hits = {};
  let total = 0;
  for (const f of files) {
    const out = [];
    lines[f].forEach((ln, i) => {
      if (new RegExp("['\"]" + sid + "['\"]").test(ln)) out.push(i + 1);
    });
    hits[f] = out; total += out.length;
  }
  const meta = D.SKILLS[sid] || {};
  rows.push({ sid, name: meta.name || '?', owners: owners.join('/'), total, hits });
}
rows.sort((a, b) => a.total - b.total || a.sid.localeCompare(b.sid));
console.log('技能总数(含动态授予):', rows.length, '  GENERALS 引用去重:', new Set(D.GENERALS.flatMap(g => g.skills)).size);
for (const r of rows) {
  const tag = r.total === 0 ? 'REF0' : r.total <= 2 ? 'LOW ' : '    ';
  console.log(`${tag} ${r.sid.padEnd(12)} ${String(r.name).padEnd(6)} 总${String(r.total).padStart(2)}  skills[${r.hits['skills.js'].join(',')}] cards[${r.hits['cards.js'].join(',')}] game[${r.hits['game.js'].join(',')}] ai[${r.hits['ai.js'].join(',')}]  ${r.owners}`);
}
