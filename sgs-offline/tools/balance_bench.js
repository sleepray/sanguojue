#!/usr/bin/env node
/* 三国杀 1.0.8 阵营平衡统计
 * 用法：
 *   node tools/balance_bench.js --mode=5p --games=400 --seed=1000 --level=normal
 *   node tools/balance_bench.js --mode=8p --games=100 --seed=1000 --json
 * 指标：胜方阵营/回合/超时、各阵营首个阵亡回合、主公阵亡分布、误伤率、
 * 主公濒死有桃忠臣出桃率、AI 身份推断准确率/首次判断回合、内奸最后两人存活率、风格（如有）。
 * 真实身份只在本工具里读取，AI 仍只使用自己的公开信息推断。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const base = path.join(__dirname, '..', 'js');
for (const f of ['skilldesc', 'data', 'game', 'cards', 'skills']) require(path.join(base, f + '.js'));
const SGS = globalThis.SGS;
const Game = SGS.Game;

const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] == null ? true : m[2];
}
const MODE = flags.mode || '8p';
if (!['5p', '8p'].includes(MODE)) { console.error('mode 必须是 5p 或 8p'); process.exit(2); }
const GAMES = Math.max(1, Number(flags.games || 100));
const SEED = Number(flags.seed || flags.startSeed || 1000);
const LEVEL = flags.level || flags.difficulty || 'normal';
if (!['easy', 'normal', 'hard'].includes(LEVEL)) { console.error('level 必须是 easy/normal/hard'); process.exit(2); }
const JSON_OUT = !!flags.json;
const TIMEOUT = Math.max(1000, Number(flags.timeout || 30000));
const PLAYER_ROLE = flags['player-role'] || flags.playerRole || null;
if (PLAYER_ROLE && !['lord','loyalist','rebel','renegade'].includes(PLAYER_ROLE)) { console.error('player-role 必须是 lord/loyalist/rebel/renegade'); process.exit(2); }
const PROXY_LEVEL = flags.proxy || 'easy';
const AI_FILE = flags.ai ? path.resolve(flags.ai) : path.join(base, 'ai.js');
require(AI_FILE);
const AI_HASH = crypto.createHash('sha256').update(fs.readFileSync(AI_FILE)).digest('hex');
const TAG = flags.tag ? String(flags.tag).replace(/[^a-zA-Z0-9_-]/g, '') + '_' : '';
const OUTDIR = path.join(__dirname, '..', 'out', 'balance');
fs.mkdirSync(OUTDIR, { recursive: true });

const CAMP = { lord: 'lord', loyalist: 'lord', rebel: 'rebel', renegade: 'renegade' };
const ROLE_CN = { lord: '主公', loyalist: '忠臣', rebel: '反贼', renegade: '内奸' };
const HARM_AS = new Set(['sha', 'huosha', 'leisha', 'juedou', 'huogong', 'guohe', 'shunshou', 'lebu', 'bingliang']);
const HARM_SKILL = new Set(['qiangxi', 'tiaoxin', 'lijian', 'quhu', 'j_quhu', 'luanwu', 'luanji', 'nanman', 'wanjian']);
function sameCamp(a, b) {
  if (a === 'lord' || a === 'loyalist') return b === 'lord' || b === 'loyalist';
  if (a === 'rebel') return b === 'rebel';
  return b === 'renegade';
}
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
function ci(k, n) { const [a, b] = wilson(k, n); return { low: +(a * 100).toFixed(1), high: +(b * 100).toFixed(1) }; }
function pct(k, n) { return n ? +(100 * k / n).toFixed(1) : null; }

// ---- 全局钩子：误伤、救援、身份推断 ----
const origExecute = Game.prototype.executeAction;
Game.prototype.executeAction = async function (p, act) {
  const b = this._balance;
  if (b && act && p && p.role) {
    const t = (act.kind === 'card' ? act.as : act.skill) || '';
    const harm = (act.kind === 'card' && HARM_AS.has(t)) || (act.kind === 'skill' && HARM_SKILL.has(t));
    if (harm) {
      const targets = Array.isArray(act.targets) ? act.targets : [];
      const actorCamp = CAMP[p.role];
      let anySame = false;
      targets.forEach(s => {
        const q = this.players[s];
        if (!q || q.seat === p.seat || !q.role) return;
        b.harmTargets++;
        const bc = b.harmByCamp[actorCamp] || (b.harmByCamp[actorCamp] = { targets: 0, same: 0 });
        bc.targets++;
        if (sameCamp(p.role, q.role)) { b.friendlyTargets++; bc.same++; anySame = true; }
      });
      if (targets.length) {
        b.harmActions++;
        if (anySame) b.friendlyActions++;
      }
    }
  }
  return origExecute.call(this, p, act);
};

const origPeach = Game.prototype.askForPeach;
Game.prototype.askForPeach = async function (healer, dying) {
  const b = this._balance;
  let eligible = false, hasTao = false;
  if (b && healer && dying && dying.role === 'lord' && (healer.role === 'loyalist' || healer.role === 'renegade')) {
    hasTao = [...(healer.hand || []), ...Object.values(healer.equips || {}).filter(Boolean)].some(c => c.name === 'tao');
    if (hasTao) { b.rescueChances++; b.rescueByRole[healer.role] = b.rescueByRole[healer.role] || { chances: 0, success: 0 }; b.rescueByRole[healer.role].chances++; eligible = true; }
  }
  const r = await origPeach.call(this, healer, dying);
  if (eligible && r) { b.rescueSuccess++; b.rescueByRole[healer.role].success++; }
  return r;
};

const origKill = Game.prototype.kill;
Game.prototype.kill = async function (p, source) {
  const before = p && p.alive;
  const r = await origKill.call(this, p, source);
  if (before && p && !p.alive && this._balance) {
    this._balance.deathSeq++;
    p._balanceDeathOrder = this._balance.deathSeq;
  }
  return r;
};

const origTakeTurn = Game.prototype.takeTurn;
Game.prototype.takeTurn = async function () {
  const r = await origTakeTurn.call(this);
  if (this._balance && !this.over) sampleInference(this);
  return r;
};

function sampleInference(g) {
  const b = g._balance;
  if (!b || !g.agents) return;
  g.agents.forEach((ai, aiSeat) => {
    if (!ai || !ai.p || !ai.p.role) return;
    if (typeof ai.scanPublicEvents === 'function') { try { ai.scanPublicEvents(); } catch (e) { /* ignore */ } }
    for (const q of g.players) {
      if (!q || q.seat === aiSeat || !q.role || !q.alive) continue;
      let rel = 'neutral';
      try { rel = ai.inferred ? ai.inferred(q.seat) : 'neutral'; } catch (e) { /* ignore */ }
      if (rel !== 'friend' && rel !== 'enemy') continue;
      const truthFriend = sameCamp(ai.p.role, q.role);
      b.infer.total++;
      if ((rel === 'friend') === truthFriend) b.infer.correct++;
      const by = b.infer.byCamp[CAMP[ai.p.role]] || (b.infer.byCamp[CAMP[ai.p.role]] = { total: 0, correct: 0 });
      by.total++; if ((rel === 'friend') === truthFriend) by.correct++;
      b.infer.byRole[ai.p.role] = b.infer.byRole[ai.p.role] || { total: 0, correct: 0 };
      b.infer.byRole[ai.p.role].total++;
      if ((rel === 'friend') === truthFriend) b.infer.byRole[ai.p.role].correct++;
      const key = aiSeat + ':' + q.seat;
      if (!b.infer.first[key]) b.infer.first[key] = { turn: g.turnCount + 1, rel, aiRole: ai.p.role, targetRole: q.role };
    }
  });
}

function newBench(mode, seed) {
  return {
    mode, seed,
    harmTargets: 0, friendlyTargets: 0, harmActions: 0, friendlyActions: 0,
    harmByCamp: {}, rescueChances: 0, rescueSuccess: 0, rescueByRole: {}, deathSeq: 0,
    infer: { total: 0, correct: 0, byCamp: {}, byRole: {}, first: {} },
  };
}

async function runOne(mode, seed) {
  const n = mode === '8p' ? 8 : 5;
  const g = new Game({ mode, seed, cardPack: 'full', humanSeat: -1, onUpdate() {} });
  const b = g._balance = newBench(mode, seed);
  if (PLAYER_ROLE) {
    const origSetup = g.setup.bind(g);
    g.setup = function () {
      origSetup();
      const human = this.players[0];
      if (!human || human.role === PLAYER_ROLE) { if (human && human.role === 'lord') this.lordSeat = 0; return; }
      if (PLAYER_ROLE === 'lord') {
        const lord = this.players.find(p => p.role === 'lord');
        if (lord) { const r = human.role; human.role = 'lord'; lord.role = r; this.lordSeat = 0; }
      } else {
        const other = this.players.find(p => p.role === PLAYER_ROLE);
        if (other) { const r = human.role; human.role = PLAYER_ROLE; other.role = r; }
      }
    };
  }
  const agents = [];
  for (let i = 0; i < n; i++) agents.push(new SGS.AI(g, i, { speed: 0, level: (PLAYER_ROLE && i === 0) ? PROXY_LEVEL : LEVEL }));
  g.agents = agents;
  const t0 = Date.now();
  let timedOut = false, timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => { timedOut = true; try { g.over = true; } catch (e) { /* ignore */ } resolve(); }, TIMEOUT); });
  let crash = null;
  try { await Promise.race([g.start(), timeout]); } catch (e) { crash = String((e && e.stack) || e).slice(0, 600); try { g.over = true; } catch (e2) { /* ignore */ } }
  clearTimeout(timer);
  if (!g.over && !timedOut) { /* game.start should finish */ }
  if (!g.over) timedOut = true;
  try { sampleInference(g); } catch (e) { /* ignore */ }
  const players = g.players.map(p => ({
    seat: p.seat, role: p.role, camp: CAMP[p.role], general: p.general && p.general.name,
    alive: p.alive, hp: p.hp, deathTurn: p.deathTurn == null ? null : p.deathTurn,
    style: agents[p.seat] && (agents[p.seat].style || agents[p.seat].playStyle || agents[p.seat]._style) || null,
  }));
  const firstDeath = {};
  for (const p of players) if (p.deathTurn != null) {
    const c = p.camp;
    if (firstDeath[c] == null || p.deathTurn < firstDeath[c]) firstDeath[c] = p.deathTurn;
  }
  const lord = players.find(p => p.role === 'lord');
  const aliveCount = players.filter(p => p.alive).length;
  return {
    seed, mode, ms: Date.now() - t0, timedOut: !!(timedOut || /超时/.test(g.winText || '')), crash,
    winner: g.winner || null, winText: g.winText || '', turns: g.turnCount,
    firstDeath, lordDeathTurn: lord && !lord.alive ? lord.deathTurn : null,
    aliveCount, renegadeAlive: players.some(p => p.role === 'renegade' && p.alive),
    renegadeLastTwo: players.some(p => p.role === 'renegade' && p.alive) && aliveCount <= 2,
    renegadeFinalRank: (() => { const rp = g.players.find(x => x.role === 'renegade'); if (!rp) return null; if (g.winner === 'renegade') return 1; if (rp.alive) return Math.max(1, aliveCount); return Math.max(1, g.players.length - (rp._balanceDeathOrder || g.players.length) + 1); })(),
    players, stats: b,
    playerRole: PLAYER_ROLE || null,
    playerCamp: PLAYER_ROLE ? CAMP[PLAYER_ROLE] : null,
    playerWon: PLAYER_ROLE ? (g.winner === CAMP[PLAYER_ROLE] || (CAMP[PLAYER_ROLE] === 'lord' && g.winner === 'lord')) : null,
  };
}

async function main() {
const results = [];
for (let i = 0; i < GAMES; i++) {
  const seed = SEED + i;
  const r = await runOne(MODE, seed);
  results.push(r);
  if (!JSON_OUT && ((i + 1) % 10 === 0 || i === GAMES - 1)) process.stderr.write(`\r${i + 1}/${GAMES}`);
}
if (!JSON_OUT) process.stderr.write('\n');

function summarize() {
  const n = results.length;
  const wins = { lord: 0, rebel: 0, renegade: 0, draw: 0 };
  let timeouts = 0, crashes = 0, turns = 0, ms = 0;
  let harmTargets = 0, friendlyTargets = 0, harmActions = 0, friendlyActions = 0;
  let rescueChances = 0, rescueSuccess = 0;
  let inferTotal = 0, inferCorrect = 0;
  const inferByCamp = {};
  const rescueByRole = {};
  const lordDeaths = [];
  const firstDeathSum = { lord: [], rebel: [], renegade: [] };
  let renegadeLastTwo = 0;
  const renegadeRanks = [];
  const firstJudgeTurns = [];
  const firstJudgeByCamp = {};
  const styles = {};
  let playerWins = 0, playerGames = 0;
  for (const r of results) {
    if (r.winner === 'lord' || r.winner === 'rebel' || r.winner === 'renegade') wins[r.winner]++; else wins.draw++;
    if (r.timedOut) timeouts++;
    if (r.crash) crashes++;
    turns += r.turns; ms += r.ms;
    if (r.lordDeathTurn != null) lordDeaths.push(r.lordDeathTurn);
    for (const c of Object.keys(firstDeathSum)) if (r.firstDeath[c] != null) firstDeathSum[c].push(r.firstDeath[c]);
    if (r.renegadeLastTwo) renegadeLastTwo++;
    if (r.playerRole) { playerGames++; if (r.playerWon) playerWins++; }
    if (r.renegadeFinalRank != null) renegadeRanks.push(r.renegadeFinalRank);
    for (const v of Object.values(r.stats.infer.first)) { firstJudgeTurns.push(v.turn); const fc = CAMP[v.aiRole]; firstJudgeByCamp[fc] = firstJudgeByCamp[fc] || []; firstJudgeByCamp[fc].push(v.turn); }
    const b = r.stats;
    harmTargets += b.harmTargets; friendlyTargets += b.friendlyTargets;
    harmActions += b.harmActions; friendlyActions += b.friendlyActions;
    rescueChances += b.rescueChances; rescueSuccess += b.rescueSuccess;
    for (const [k, v] of Object.entries(b.rescueByRole || {})) { const d = rescueByRole[k] || (rescueByRole[k] = { chances: 0, success: 0 }); d.chances += v.chances; d.success += v.success; }
    inferTotal += b.infer.total; inferCorrect += b.infer.correct;
    for (const [k, v] of Object.entries(b.infer.byCamp)) {
      const d = inferByCamp[k] || (inferByCamp[k] = { total: 0, correct: 0 });
      d.total += v.total; d.correct += v.correct;
    }
    for (const p of r.players) if (p.style) styles[p.style] = (styles[p.style] || 0) + 1;
  }
  const avg = arr => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
  const lordHist = {};
  lordDeaths.forEach(t => { const k = t <= 5 ? '1-5' : t <= 10 ? '6-10' : t <= 15 ? '11-15' : t <= 20 ? '16-20' : t <= 30 ? '21-30' : '31+'; lordHist[k] = (lordHist[k] || 0) + 1; });
  return {
    mode: MODE, games: n, seedStart: SEED, level: LEVEL, aiFile: AI_FILE, aiHash: AI_HASH,
    wins, winRate: {
      lord: pct(wins.lord, n), rebel: pct(wins.rebel, n), renegade: pct(wins.renegade, n), draw: pct(wins.draw, n),
    },
    ci: { lord: ci(wins.lord, n), rebel: ci(wins.rebel, n), renegade: ci(wins.renegade, n) },
    avgTurns: avg(results.map(r => r.turns)), timeouts, timeoutRate: pct(timeouts, n), crashes,
    avgMs: n ? Math.round(ms / n) : 0,
    firstDeathAvg: { lord: avg(firstDeathSum.lord), rebel: avg(firstDeathSum.rebel), renegade: avg(firstDeathSum.renegade) },
    lordDeathAvg: avg(lordDeaths), lordDeathHist: lordHist,
    harm: {
      targetRate: pct(friendlyTargets, harmTargets), friendlyTargets, harmTargets,
      actionRate: pct(friendlyActions, harmActions), friendlyActions, harmActions,
      byCamp: Object.fromEntries(Object.entries((() => { const o = {}; for (const r of results) for (const [k, v] of Object.entries(r.stats.harmByCamp)) { o[k] = o[k] || { targets: 0, same: 0 }; o[k].targets += v.targets; o[k].same += v.same; } return o; })()).map(([k, v]) => [k, { rate: pct(v.same, v.targets), same: v.same, targets: v.targets }])),
    },
    rescue: { rate: pct(rescueSuccess, rescueChances), success: rescueSuccess, chances: rescueChances, byRole: Object.fromEntries(Object.entries(rescueByRole).map(([k, v]) => [k, { rate: pct(v.success, v.chances), success: v.success, chances: v.chances }])) },
    inference: { accuracy: pct(inferCorrect, inferTotal), correct: inferCorrect, total: inferTotal, byCamp: Object.fromEntries(Object.entries(inferByCamp).map(([k, v]) => [k, { accuracy: pct(v.correct, v.total), correct: v.correct, total: v.total }])) },
    renegadeLastTwo: { rate: pct(renegadeLastTwo, n), count: renegadeLastTwo },
    renegadeRank: { avg: avg(renegadeRanks), values: renegadeRanks },
    firstJudge: { avgTurn: avg(firstJudgeTurns), histogram: (() => { const h = {}; firstJudgeTurns.forEach(t => { const k = t <= 3 ? '1-3' : t <= 6 ? '4-6' : t <= 10 ? '7-10' : t <= 15 ? '11-15' : '16+'; h[k] = (h[k] || 0) + 1; }); return h; })(), byCampAvg: Object.fromEntries(Object.entries(firstJudgeByCamp).map(([k, v]) => [k, avg(v)])) },
    styles,
    player: PLAYER_ROLE ? { role: PLAYER_ROLE, proxyLevel: PROXY_LEVEL, camp: CAMP[PLAYER_ROLE], wins: playerWins, games: playerGames, winRate: pct(playerWins, playerGames), ci: ci(playerWins, playerGames) } : null,
  };
}
const summary = summarize();
const out = { generated: new Date().toISOString(), summary, results };
const file = path.join(OUTDIR, `${TAG}${PLAYER_ROLE ? 'player_' + PLAYER_ROLE + '_' : ''}${MODE}_${LEVEL}_${SEED}_${GAMES}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 2));
if (JSON_OUT) {
  console.log(JSON.stringify({ file, summary }, null, 2));
} else {
  const s = summary;
  console.log(`\n== 平衡统计 ${MODE} ${LEVEL} games=${s.games} seed=${s.seedStart} ==`);
  console.log(`胜率：主公方 ${s.winRate.lord}% [${s.ci.lord.low}-${s.ci.lord.high}]  反贼 ${s.winRate.rebel}% [${s.ci.rebel.low}-${s.ci.rebel.high}]  内奸 ${s.winRate.renegade}% [${s.ci.renegade.low}-${s.ci.renegade.high}]  平局 ${s.winRate.draw}%`);
  console.log(`回合：平均 ${s.avgTurns}；超时 ${s.timeouts} (${s.timeoutRate}%)；崩溃 ${s.crashes}；平均耗时 ${s.avgMs}ms/局`);
  console.log(`首阵亡：主忠 ${s.firstDeathAvg.lord} / 反贼 ${s.firstDeathAvg.rebel} / 内奸 ${s.firstDeathAvg.renegade}`);
  console.log(`主公阵亡：平均 ${s.lordDeathAvg}，分布 ${JSON.stringify(s.lordDeathHist)}`);
  console.log(`误伤：目标率 ${s.harm.targetRate}% (${s.harm.friendlyTargets}/${s.harm.harmTargets})，动作率 ${s.harm.actionRate}% (${s.harm.friendlyActions}/${s.harm.harmActions})`);
  console.log(`救援：${s.rescue.rate}% (${s.rescue.success}/${s.rescue.chances})，按角色 ${JSON.stringify(s.rescue.byRole)}`);
  console.log(`推断：${s.inference.accuracy}% (${s.inference.correct}/${s.inference.total})，按阵营 ${JSON.stringify(s.inference.byCamp)}`);
  console.log(`内奸最后两人存活：${s.renegadeLastTwo.rate}% (${s.renegadeLastTwo.count}/${s.games})，平均名次 ${s.renegadeRank.avg}`);
  console.log(`首次推断：平均第 ${s.firstJudge.avgTurn} 回合，分布 ${JSON.stringify(s.firstJudge.histogram)}，按阵营 ${JSON.stringify(s.firstJudge.byCampAvg)}`);
  console.log(`风格：${JSON.stringify(s.styles)}`);
  if (s.player) console.log(`玩家视角：${s.player.role} 阵营胜率 ${s.player.winRate}% [${s.player.ci.low}-${s.player.ci.high}] (${s.player.wins}/${s.player.games})，代理=${s.player.proxyLevel}`);
  console.log(`JSON: ${file}`);
}

}

main().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(2); });
