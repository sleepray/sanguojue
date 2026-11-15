/* 数据自检：牌堆张数/牌名、武将、技能、素材文件 */
const path = require('path');
const fs = require('fs');
const base = path.join(__dirname, '..');
require(path.join(base, 'js', 'skilldesc.js'));
require(path.join(base, 'js', 'data.js'));
const D = globalThis.SGS_DATA;
let fail = 0;
function ok(cond, msg) { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) fail++; }

const count = (spec) => spec.reduce((m, [n]) => (m[n] = (m[n] || 0) + 1, m), {});
const std = count(D.DECK_STANDARD), man = count(D.DECK_MANEUVERING), all = count(D.DECK_STANDARD.concat(D.DECK_MANEUVERING));
ok(D.DECK_STANDARD.length === 108, `标准牌堆 108（实际 ${D.DECK_STANDARD.length}）`);
ok(D.DECK_MANEUVERING.length === 52, `军争牌堆 52（实际 ${D.DECK_MANEUVERING.length}）`);
ok(D.DECK_STANDARD.length + D.DECK_MANEUVERING.length === 160, '合计 160');
const ban = Object.assign({}, D.DECK_1V1_BAN);
const duel = D.DECK_STANDARD.concat(D.DECK_MANEUVERING).filter(([n]) => { if ((ban[n] || 0) > 0) { ban[n] -= 1; return false; } return true; });
ok(duel.length === 108, `1v1 牌堆 108（实际 ${duel.length}）`);
ok(Object.values(ban).every((v) => v === 0), '1v1 禁牌表全部命中');
ok(D.GENERALS.length === 87, `武将 57+30 变体（实际 ${D.GENERALS.length}）`);
ok(D.EXTRA_GENERALS.length === 30 && D.EXTRAS_PACK.defaultEnabled === false, `变体扩展 30 名，默认关闭（实际 ${D.EXTRA_GENERALS.length}）`);
ok(D.GENERALS.every((g) => g.gradation === 0), '默认 0 阶（金龙关闭，g gradation=0）');
const packs = {};
D.GENERALS.forEach((g) => { packs[g.pack] = (packs[g.pack] || 0) + 1; });
ok(packs['标准'] === 25 && packs['风'] === 8 && packs['火'] === 8 && packs['林'] === 8 && packs['山'] === 8, `分包 ${JSON.stringify(packs)}`);
const skillIds = new Set();
D.GENERALS.forEach((g) => g.skills.forEach((s) => skillIds.add(s)));
let noDesc = 0, noImpl = 0;
skillIds.forEach((s) => { if (!D.SKILLS[s] || !D.SKILLS[s].desc) noDesc++; });
ok(noDesc === 0, `技能文案缺失 ${noDesc}`);
const cardKeys = new Set(Object.keys(D.CARDS));
let missing = 0;
for (const n of cardKeys) if (!fs.existsSync(path.join(base, 'assets', 'cards', D.CARDS[n].pinyin + '.png'))) { missing++; console.log('  缺牌图', n); }
ok(missing === 0, `牌图缺失 ${missing}`);
let missSeat = 0, missBig = 0;
for (const g of D.GENERALS) {
  const id = String(g.id).padStart(3, '0');
  if (!fs.existsSync(path.join(base, 'assets', 'seat', id + '.png'))) { missSeat++; console.log('  缺座位图', id); }
  if (!fs.existsSync(path.join(base, 'assets', 'big', id + '.png'))) missBig++;
}
ok(missSeat === 0, `座位立绘缺失 ${missSeat}`);
console.log('INFO 大立绘缺失 ' + missBig + '（031/032/033，用座位图兜底）');
const audioIdx = JSON.parse(fs.readFileSync(path.join(base, 'assets', 'audio_index.json'), 'utf8'));
ok(audioIdx && Object.keys(audioIdx.generals || {}).length >= 50, `武将语音 ${Object.keys(audioIdx.generals || {}).length}/57`);
console.log(fail ? ('\nFAILED ' + fail) : '\nALL PASS');
process.exit(fail ? 1 : 0);
