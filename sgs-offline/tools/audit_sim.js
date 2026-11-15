/* 只读审计脚本：跑对局并统计技能触发/未实现日志/异常，不改引擎 */
const path = require('path');
const base = path.join(__dirname, '..', 'js');
require(path.join(base, 'skilldesc.js'));
require(path.join(base, 'data.js'));
require(path.join(base, 'game.js'));
require(path.join(base, 'cards.js'));
require(path.join(base, 'skills.js'));
require(path.join(base, 'ai.js'));
const SGS = globalThis.SGS, D = globalThis.SGS_DATA;

async function run(mode, seed) {
  const g = new SGS.Game({ mode, seed, cardPack: 'full', humanSeat: -1, onUpdate() {} });
  const n = mode === '5p' ? 5 : 8;
  const agents = [];
  for (let i = 0; i < n; i++) agents.push(new SGS.AI(g, i, { speed: 0 }));
  g.agents = agents;
  const all = [];
  const orig = g.log.bind(g);
  g.log = (t, ty) => { all.push({ t, ty }); return orig(t, ty); };
  await g.start();
  return { g, logs: all };
}
(async () => {
  const n8 = Number(process.argv[2] || 6), n1 = Number(process.argv[3] || 6);
  const counts = {}, games = [], crash = [];
  const track = (logs) => {
    for (const l of logs) {
      const m = l.t.match(/【([^】]+)】/g);
      if (m) for (const s of m) counts[s] = (counts[s] || 0) + 1;
      if (/暂未实现/.test(l.t)) counts['__UNIMPLEMENTED__'] = (counts['__UNIMPLEMENTED__'] || 0) + 1;
    }
  };
  for (let i = 0; i < n8; i++) {
    try { const r = await run('8p', 7000 + i); track(r.logs); games.push({ mode: '8p', seed: 7000 + i, turns: r.g.turnCount, winner: r.g.winner, players: r.g.players.map(p => p.general.name + (p.alive ? '' : '×')).join(',') }); }
    catch (e) { crash.push({ mode: '8p', seed: 7000 + i, err: String(e && e.stack || e) }); }
  }
  for (let i = 0; i < n1; i++) {
    try { const r = await run('1v1', 8000 + i); track(r.logs); games.push({ mode: '1v1', seed: 8000 + i, turns: r.g.turnCount, winner: r.g.winner, players: r.g.players.map(p => p.general.name + (p.alive ? '' : '×')).join(',') }); }
    catch (e) { crash.push({ mode: '1v1', seed: 8000 + i, err: String(e && e.stack || e) }); }
  }
  console.log(JSON.stringify({ games, crashes: crash.length, crashDetail: crash }, null, 1));
  const names = [...new Set(D.GENERALS.flatMap(g => g.skills))].map(s => (D.SKILLS[s] && D.SKILLS[s].name) || s);
  const shown = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log('\n=== 技能名出现次数（含文案引用，非严格发动次数） ===');
  console.log(shown.filter(([k]) => k !== '__UNIMPLEMENTED__').map(([k, v]) => `${k}:${v}`).join('  '));
  console.log('\n未在12局日志出现的技能:', names.filter(n => !counts['【' + n + '】']).join('、'));
  console.log('未实现日志次数:', counts['__UNIMPLEMENTED__'] || 0);
})();
