const path = require('path');
const base = path.join(__dirname, '..', 'js');
require(path.join(base, 'skilldesc.js'));
require(path.join(base, 'data.js'));
require(path.join(base, 'game.js'));
require(path.join(base, 'cards.js'));
require(path.join(base, 'skills.js'));
require(path.join(base, 'ai.js'));
const SGS = globalThis.SGS;

// 可选第 3 个参数 extras：启用变体扩展包（默认关闭，不传则维持原行为）
const ARGS = process.argv.slice(2);
const WITH_EXTRAS = ARGS.indexOf('extras') >= 0;
const WITH_NEW_DUEL = ARGS.indexOf('new1v1') >= 0;
const PACKS = WITH_EXTRAS ? ['标准', '风', '火', '林', '山', 'extras'] : undefined;

async function runOne(seed, mode = '8p') {
  const g = new SGS.Game({ mode, seed, cardPack: 'full', humanSeat: -1, packs: PACKS, duelPool: WITH_NEW_DUEL ? 'new1v1' : undefined, onUpdate() {} });
  const n = mode === '5p' ? 5 : 8;
  const agents = [];
  for (let i = 0; i < n; i++) agents.push(new SGS.AI(g, i, { speed: 0 }));
  g.agents = agents;
  const t0 = Date.now();
  await g.start();
  return { seed, mode, over: g.over, winner: g.winner, turns: g.turnCount, ms: Date.now() - t0, players: g.players.map(p => `${p.general.name}(${p.role})${p.alive ? '' : '×'}`) };
}

(async () => {
  const mode = process.argv[2] || '8p';
  const n = Number(process.argv[3] || 5);
  let fails = 0;
  for (let i = 0; i < n; i++) {
    try {
      const r = await runOne(1000 + i, mode);
      console.log(JSON.stringify(r));
    } catch (e) {
      fails++;
      console.error('FAIL seed', 1000 + i, e && e.stack || e);
    }
  }
  console.log('done fails=', fails);
  process.exit(fails ? 1 : 0);
})();
