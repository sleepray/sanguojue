#!/usr/bin/env node
/* 三国杀 · 单机版 — AI 基准测试
 *
 * 用途：
 *   node tools/ai_bench.js            # 默认 100 局 8p + 100 局 1v1
 *   node tools/ai_bench.js 30 30      # 30 局 8p + 30 局 1v1
 *   node tools/ai_bench.js 100 100 --level=hard
 *   node tools/ai_bench.js 100 100 --json
 *
 * 统计内容：
 *   - 各阵营胜率（8p：主忠 / 反贼 / 内奸；1v1：先手 / 后手）
 *   - 平均回合、崩溃数、超时数
 *   - 每局平均 AI 决策次数、单局耗时、决策吞吐
 *   - 非法动作：返回值不符合 js/game.js 的 ask 契约，或目标不合法
 *   - 空转：一次 executeAction 前后游戏状态无任何变化
 *   - 无效动作：除战报外状态无变化（例如直谏了非装备牌、火攻花色不匹配）
 *   - 连续重复：同一回合连续 3 次以上选择完全相同的无效动作
 *   - score 全 0 导致直接结束：出牌阶段可选动作评分全部 <= 0 却直接结束
 *
 * 固定 seed，默认 8p 从 1000 开始、1v1 从 5000 开始；--seed8p / --seed1v1 可覆盖。
 * speed=0，不等待动画，不依赖 Math.random 的动画延迟。
 */
'use strict';

const path = require('path');
const base = path.join(__dirname, '..', 'js');
for (const f of ['skilldesc', 'data', 'game', 'cards', 'skills', 'ai']) require(path.join(base, f + '.js'));
const SGS = globalThis.SGS;
const Game = SGS.Game;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of argv) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] == null ? true : m[2];
  else positional.push(a);
}
const N8P = Math.max(0, Number(positional[0] == null ? 100 : positional[0]) || 0);
const N1V1 = Math.max(0, Number(positional[1] == null ? 100 : positional[1]) || 0);
const SEED8P = flags.seed8p == null ? 1000 : Number(flags.seed8p);
const SEED1V1 = flags.seed1v1 == null ? 5000 : Number(flags.seed1v1);
const LEVEL = flags.level || flags.aiLevel || 'normal';
const JSON_OUT = !!flags.json;
const VERBOSE = !!flags.verbose;
const GAME_TIMEOUT_MS = Number(flags.timeout || 0) || 20000;

if (!['easy', 'normal', 'hard'].includes(LEVEL)) {
  console.error(`未知难度：${LEVEL}（可选 easy / normal / hard）`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 全局插桩：统计 action 执行效果、战报条数、引擎内部 error
// ---------------------------------------------------------------------------
const origLog = Game.prototype.log;
Game.prototype.log = function (...args) {
  const r = origLog.apply(this, args);
  if (this._bench) this._bench.logCount++;
  return r;
};

function sigState(g, withLogs) {
  const parts = [g.turnCount, g.currentSeat, g.deck.length, g.discardPile.length, g.table.length];
  for (const p of g.players) {
    parts.push(
      p.alive ? 1 : 0, p.hp, p.maxHp, p.hand.length, p.judges.length,
      p.equips.weapon ? 1 : 0, p.equips.armor ? 1 : 0, p.equips.offhorse ? 1 : 0, p.equips.defhorse ? 1 : 0,
      p.drank || 0, p.slashCount || 0, p.chained ? 1 : 0, p.flipped ? 1 : 0,
      Object.keys(p.flags || {}).length, Object.keys(p.used || {}).length,
      Object.keys(p.once || {}).length, Object.keys(p.marks || {}).length,
    );
  }
  if (withLogs) parts.push(g._bench ? g._bench.logCount : g.logs.length);
  return parts.join(',');
}

function actionKey(act) {
  if (!act) return 'null';
  const cards = act.kind === 'card' ? act.subcards : act.cards;
  return JSON.stringify([
    act.kind, act.skill || null, act.as || null,
    (cards || []).slice().sort((a, b) => a - b),
    (act.targets || []).slice(),
  ]);
}

const origExecute = Game.prototype.executeAction;
Game.prototype.executeAction = async function (p, act) {
  const b = this._bench;
  if (!b || !act || act.kind === 'end') return origExecute.call(this, p, act);
  const before = sigState(this, false);
  const key = actionKey(act);
  const label = act.kind === 'card' ? (act.as || '?') : ('skill:' + (act.skill || '?'));
  b.actions++;
  const r = await origExecute.call(this, p, act);
  const after = sigState(this, false);
  const ineffective = before === after;
  const pureNoop = ineffective && b.logCount === b.logAtActionStart;
  const det = b.byAction[label] || (b.byAction[label] = { n: 0, ineffective: 0, noop: 0 });
  det.n++;
  if (ineffective) det.ineffective++;
  if (pureNoop) det.noop++;
  if (ineffective) {
    b.ineffective++;
    // 连续相同无效动作 >= 3 次 → 判为空转死循环
    if (b.stall.key === key && b.stall.seat === p.seat && b.stall.turn === this.turnCount) {
      b.stall.count++;
    } else {
      b.stall = { key, seat: p.seat, turn: this.turnCount, count: 1 };
    }
    if (b.stall.count === 3) b.stalls++;
  } else {
    b.stall = { key, seat: p.seat, turn: this.turnCount, count: 0 };
  }
  // 纯空转：连战报都没有
  if (pureNoop) b.noops++;
  return r;
};

// 每次出牌动作前记录 logCount，供 noop 判断
const origBuildPlayActions = Game.prototype.buildPlayActions;
Game.prototype.buildPlayActions = function (p) {
  if (this._bench) this._bench.logAtActionStart = this._bench.logCount;
  return origBuildPlayActions.call(this, p);
};

// ---------------------------------------------------------------------------
// 契约校验
// ---------------------------------------------------------------------------
const sameSet = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const sa = a.slice().sort((x, y) => x - y), sb = b.slice().sort((x, y) => x - y);
  return sa.every((v, i) => v === sb[i]);
};
const trunc = (v, n = 160) => {
  let s;
  try { s = JSON.stringify(v); } catch (e) { s = String(v); }
  if (s == null) s = String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function validate(ai, req, res, b) {
  const g = ai.game;
  const p = req.player || ai.p;
  const issues = [];
  const bad = (m) => issues.push(m);
  if (!p) { bad('no-player'); return issues; }

  const type = req.type;
  if (type === 'play') {
    const acts = req.actions || [];
    if (!res || typeof res !== 'object') { bad('play 返回空'); return issues; }
    const act = res.action ? res.action : res;
    if (!act || typeof act !== 'object') { bad('play 动作非对象'); return issues; }
    if (act.kind === 'end') return issues;
    const sameKind = acts.filter((t) => {
      if (t.kind !== act.kind) return false;
      if (act.kind === 'card') return (t.as || null) === (act.as || null) && (t.skill || null) === (act.skill || null);
      return (t.skill || null) === (act.skill || null);
    });
    if (!sameKind.length) { bad(`动作不在模板中：kind=${act.kind} as=${act.as} skill=${act.skill}`); return issues; }
    const cards = act.kind === 'card' ? (act.subcards || []) : (act.cards || []);
    let tpl = sameKind[0];
    if (act.kind === 'card') {
      // 手里可能有多张同名牌，按实际出的牌匹配模板
      const exact = sameKind.find((t) => sameSet(t.subcards || [], cards));
      if (!exact) { bad(`牌与任何模板不一致：${trunc(cards)}`); return issues; }
      tpl = exact;
    } else if (tpl.needsCards) {
      const min = tpl.needsCards.min || 0, max = tpl.needsCards.max == null ? min : tpl.needsCards.max;
      if (cards.length < min || cards.length > max) bad(`技能出牌数 ${cards.length} 不在 [${min},${max}]`);
    }
    for (const id of cards) if (!g.findCard(p, id)) bad(`牌 ${id} 不在${p.general ? p.general.name : p.seat}号位`);
    if (tpl.sameSuit && cards.length >= 2) {
      const cs = cards.map((id) => g.findCard(p, id)).filter(Boolean);
      if (cs.length >= 2 && cs[0].suit !== cs[1].suit) bad('乱击两张牌花色不同');
    }
    const targets = Array.isArray(act.targets) ? act.targets : [];
    // 技能模板用 targetCandidates 表示“需要目标”，不一定带 needsTargets 字段
    const needsTargets = tpl.needsTargets || (tpl.kind === 'skill' && (tpl.targetCandidates || []).length > 0);
    if (needsTargets) {
      const cands = tpl.targetCandidates || [];
      const min = tpl.minTargets || 0, max = tpl.maxTargets == null ? min : tpl.maxTargets;
      if (act.kind === 'card' && act.as === 'jiedao') {
        if (targets.length !== 2) bad(`借刀目标数 ${targets.length}≠2`);
        if (targets[0] != null && !cands.includes(targets[0])) bad(`借刀第一目标 ${targets[0]} 不在候选`);
        if (targets.length === 2) {
          const seconds = g.legalSecondTargetsFor(p, 'jiedao', targets[0]);
          if (!seconds.includes(targets[1])) bad(`借刀第二目标 ${targets[1]} 不合法`);
        }
      } else {
        if (targets.length < min || targets.length > max) bad(`目标数 ${targets.length} 不在 [${min},${max}]（${act.as || act.skill}）`);
        for (const s of targets) if (!cands.includes(s)) bad(`目标 ${s} 不在候选（${act.as || act.skill}）`);
      }
      if (new Set(targets).size !== targets.length) bad('目标重复');
    } else if (targets.length) {
      bad(`非指定目标动作却返回目标 ${trunc(targets)}`);
    }
    // 友方伤害检测
    const dmg = ['sha', 'huosha', 'leisha', 'juedou', 'huogong'];
    if (act.kind === 'card' && dmg.includes(act.as)) {
      for (const s of targets) {
        const q = g.players[s];
        if (!q || q.seat === p.seat) continue;
        if (ai.relation(q) === 'friend') { b.friendlyFire++; break; }
      }
    }
    if (act.kind === 'skill' && act.skill === 'qiangxi') {
      for (const s of targets) {
        const q = g.players[s];
        if (q && q.seat !== p.seat && ai.relation(q) === 'friend') { b.friendlyFire++; break; }
      }
    }
    if ((act.kind === 'card' && ['nanman', 'wanjian'].includes(act.as)) || (act.kind === 'skill' && ['luanji', 'luanwu'].includes(act.skill))) {
      let fr = 0, en = 0;
      for (const q of g.alivePlayers) {
        if (q.seat === p.seat) continue;
        const r = ai.relation(q);
        if (r === 'friend') fr++; else if (r === 'enemy') en++;
      }
      // 只有“友方不少于敌方”时才算可疑的友伤 AOE
      if (fr && fr >= en) b.aoeWithFriends++;
    }
    return issues;
  }

  if (type === 'response') {
    if (res == null) return issues;
    if (typeof res !== 'object') { bad('response 非对象'); return issues; }
    if (res.cardId == null) { bad('response 缺少 cardId'); return issues; }
    const opts = req.options || [];
    if (!opts.some((o) => o.cardId === res.cardId)) bad(`response 牌 ${res.cardId} 不在选项`);
    return issues;
  }

  if (type === 'chooseCards') {
    if (!Array.isArray(res)) { bad('chooseCards 非数组'); return issues; }
    const min = req.min || 0, max = req.max == null ? min : req.max;
    if (res.length < min || res.length > max) bad(`选牌数 ${res.length} 不在 [${min},${max}]`);
    const pool = new Set((req.cards || []).map((c) => c.id));
    for (const id of res) {
      const v = id && typeof id === 'object' ? id.id : id;
      if (!pool.has(v)) bad(`选牌 ${v} 不在可选中`);
    }
    if (new Set(res.map((x) => (x && typeof x === 'object' ? x.id : x))).size !== res.length) bad('选牌重复');
    return issues;
  }

  if (type === 'chooseTargets') {
    if (!Array.isArray(res)) { bad('chooseTargets 非数组'); return issues; }
    const min = req.min || 1, max = req.max == null ? min : req.max;
    if (res.length < min || res.length > max) bad(`目标数 ${res.length} 不在 [${min},${max}]`);
    const cands = req.candidates || [];
    for (const s of res) if (!cands.includes(s)) bad(`目标 ${s} 不在候选`);
    if (new Set(res).size !== res.length) bad('目标重复');
    return issues;
  }

  if (type === 'chooseOption') {
    if (res == null) { bad('chooseOption 返回空'); return issues; }
    const opts = req.options || [];
    if (!opts.some((o) => o.id === res)) bad(`选项 ${res} 不在候选`);
    return issues;
  }

  if (type === 'chooseCardFrom') {
    if (!res || typeof res !== 'object') { bad('chooseCardFrom 返回空'); return issues; }
    const choices = req.choices || [];
    if (!['hand', 'equip', 'judge'].includes(res.zone)) bad(`未知区域 ${res.zone}`);
    if (res.zone === 'hand' && !choices.some((c) => c.zone === 'hand')) bad('无可选手牌');
    if (res.zone === 'equip' && !choices.some((c) => c.zone === 'equip' && c.slot === res.slot)) bad(`装备槽 ${res.slot} 不可选`);
    if (res.zone === 'judge') {
      const id = res.cardId != null ? res.cardId : (res.card && res.card.id);
      if (!choices.some((c) => c.zone === 'judge' && c.card && (c.card.id === id || (res.cardId == null && c === res)))) {
        if (!choices.some((c) => c.zone === 'judge')) bad('无可选判定牌');
      }
    }
    return issues;
  }

  if (type === 'arrange') {
    if (!res || !Array.isArray(res.top) || !Array.isArray(res.bottom)) { bad('arrange 结构错误'); return issues; }
    const all = (req.cards || []).map((c) => c.id);
    const got = res.top.concat(res.bottom).map((c) => c.id);
    if (got.length !== all.length || !sameSet(all, got)) bad('arrange 未覆盖全部牌');
    return issues;
  }

  if (type === 'pickFrom') {
    const pool = (req.cards || []).map((c) => c.id);
    if (!pool.includes(res)) bad(`pickFrom ${trunc(res)} 不在候选`);
    return issues;
  }

  if (type === 'distribute') {
    if (!Array.isArray(res)) { bad('distribute 非数组'); return issues; }
    const cards = new Set((req.cards || []).map((c) => c.id));
    const seats = new Set(req.candidates || []);
    const used = new Set();
    for (const it of res) {
      if (!it || !cards.has(it.cardId)) { bad(`distribute 牌 ${trunc(it && it.cardId)} 不在候选`); continue; }
      if (used.has(it.cardId)) bad('distribute 重复分配');
      used.add(it.cardId);
      if (!seats.has(it.seat)) bad(`distribute 目标 ${it.seat} 不在候选`);
    }
    return issues;
  }

  if (type === 'chooseGeneral') {
    if (!res || res.index == null) { bad('chooseGeneral 缺少 index'); return issues; }
    if (!(req.candidates || [])[res.index]) bad(`chooseGeneral index ${res.index} 越界`);
    return issues;
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 带统计的 AI
// ---------------------------------------------------------------------------
class BenchAI extends SGS.AI {
  constructor(game, seat, opts) {
    super(game, seat, opts);
    this.aiLevelName = this.levelName; // 基类已解析难度，勿覆盖 this.level
  }
  async decide(req) {
    const b = this.game._bench;
    b.decisions++;
    b.byType[req.type] = (b.byType[req.type] || 0) + 1;
    const res = await super.decide(req);
    if (b) {
      try {
        const issues = validate(this, req, res, b);
        for (const m of issues) {
          b.illegal++;
          if (b.illegalSamples.length < 20) {
            b.illegalSamples.push({
              seed: b.seed, mode: b.mode, type: req.type,
              reason: req.reason, player: this.p && this.p.general ? this.p.general.name : this.seat,
              msg: m, res: trunc(res),
            });
          }
        }
      } catch (e) {
        b.illegal++;
        if (b.illegalSamples.length < 20) b.illegalSamples.push({ seed: b.seed, mode: b.mode, type: req.type, msg: '校验异常:' + (e && e.message) });
      }
      // 出牌阶段结束时的评分观测
      if (req.type === 'play') {
        const act = res && res.action ? res.action : res;
        const nonEnd = (req.actions || []).filter((a) => a.kind !== 'end');
        b.playDecisions++;
        if (!act || act.kind === 'end') {
          b.playEnds++;
          let maxScore = -Infinity;
          for (const a of nonEnd) {
            try { maxScore = Math.max(maxScore, this.scoreAction(a)); } catch (e) { /* ignore */ }
          }
          if (nonEnd.length && maxScore <= 0) b.zeroScoreEnds++;
          const th = (this.level && this.level.threshold) || 0.8;
          // easy 有评分抖动，无法用原始分判断“错过”，不做该统计
          const canJudge = !this.level || !this.level.jitter;
          if (canJudge && nonEnd.length && maxScore > th) {
            b.missedPositive++;
            if (b.missedSamples.length < 10) {
              let lab = '?';
              for (const a of nonEnd) { try { if (this.scoreAction(a) === maxScore) { lab = (a.kind === 'card' ? a.as : 'skill:' + a.skill) + '@' + (a.label || ''); break; } } catch (e) { /* ignore */ } }
              b.missedSamples.push({ seed: b.seed, turn: this.game.turnCount, player: this.p.general ? this.p.general.name : this.seat, score: +maxScore.toFixed(1), action: lab, reason: req.reason });
            }
          }
        }
      }
    }
    return res;
  }
}

// ---------------------------------------------------------------------------
// 单局
// ---------------------------------------------------------------------------
async function runOne(mode, seed) {
  const n = mode === '8p' ? 8 : 2;
  const g = new SGS.Game({ mode, seed, cardPack: 'full', humanSeat: -1, onUpdate() {} });
  const b = {
    mode, seed, decisions: 0, byType: {}, actions: 0, noops: 0, ineffective: 0, stalls: 0,
    illegal: 0, illegalSamples: [], friendlyFire: 0, aoeWithFriends: 0,
    playDecisions: 0, playEnds: 0, zeroScoreEnds: 0, missedPositive: 0, missedSamples: [], byAction: {},
    logCount: 0, logAtActionStart: 0, stall: { key: null, seat: -1, turn: -1, count: 0 },
    crashes: [], engineErrors: [],
  };
  g._bench = b;
  const agents = [];
  for (let i = 0; i < n; i++) agents.push(new BenchAI(g, i, { speed: 0, level: LEVEL }));
  g.agents = agents;

  const t0 = Date.now();
  let timedOut = false;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { timedOut = true; try { g.over = true; } catch (e) { /* ignore */ } resolve(); }, GAME_TIMEOUT_MS);
  });
  try {
    await Promise.race([g.start(), timeout]);
  } catch (e) {
    b.crashes.push(String((e && e.stack) || e).slice(0, 800));
    try { g.over = true; } catch (e2) { /* ignore */ }
  }
  clearTimeout(timer);
  const ms = Date.now() - t0;
  const engineTimeout = !timedOut && (!g.over || /超时/.test(g.winText || ''));
  return {
    mode, seed, ms, timedOut: timedOut || engineTimeout, crashes: b.crashes, engineErrors: b.engineErrors,
    winner: g.winner, winText: g.winText, over: g.over, turns: g.turnCount,
    stats: b,
    players: g.players.map((p) => `${p.general ? p.general.name : '?'}(${p.role})${p.alive ? '' : '×'}`),
  };
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + '%' : '—');

function summarize(mode, results, seedBase) {
  const games = results.length;
  const wins = { lord: 0, rebel: 0, renegade: 0, loyalist: 0, draw: 0 };
  let crashes = 0, timeouts = 0, turns = 0, ms = 0, maxMs = 0, decisions = 0, actions = 0;
  let noops = 0, ineffective = 0, stalls = 0, illegal = 0, friendlyFire = 0, aoeWithFriends = 0;
  let zeroScoreEnds = 0, missedPositive = 0, playEnds = 0, playDecisions = 0;
  const byType = {};
  const byAction = {};
  const illegalSamples = [];
  const missedSamples = [];
  const crashSamples = [];
  const turnList = [];
  for (const r of results) {
    const b = r.stats;
    if (r.crashes.length) {
      crashes++;
      if (crashSamples.length < 5) crashSamples.push({ seed: r.seed, stack: r.crashes[0] });
    }
    if (r.timedOut) timeouts++;
    turns += r.turns; ms += r.ms; maxMs = Math.max(maxMs, r.ms); turnList.push(r.turns);
    decisions += b.decisions; actions += b.actions;
    noops += b.noops; ineffective += b.ineffective; stalls += b.stalls; illegal += b.illegal;
    friendlyFire += b.friendlyFire; aoeWithFriends += b.aoeWithFriends;
    zeroScoreEnds += b.zeroScoreEnds; missedPositive += b.missedPositive;
    for (const x of (b.missedSamples || [])) if (missedSamples.length < 8) missedSamples.push(x);
    playEnds += b.playEnds; playDecisions += b.playDecisions;
    for (const k of Object.keys(b.byType)) byType[k] = (byType[k] || 0) + b.byType[k];
    for (const k of Object.keys(b.byAction || {})) {
      const d = byAction[k] || (byAction[k] = { n: 0, ineffective: 0, noop: 0 });
      d.n += b.byAction[k].n; d.ineffective += b.byAction[k].ineffective; d.noop += b.byAction[k].noop;
    }
    for (const s of b.illegalSamples) if (illegalSamples.length < 10) illegalSamples.push(s);
    if (r.winner in wins) wins[r.winner]++; else wins.draw++;
  }
  return {
    mode, games, seedBase, level: LEVEL,
    wins, winRate: {
      lord: pct(wins.lord, games),
      rebel: pct(wins.rebel, games),
      renegade: pct(wins.renegade, games),
      draw: pct(wins.draw, games),
    },
    avgTurns: games ? +(turns / games).toFixed(1) : 0,
    medianTurns: median(turnList),
    crashes, timeouts,
    avgDecisions: games ? +(decisions / games).toFixed(1) : 0,
    totalDecisions: decisions,
    decisionsByType: byType,
    actions, noops, ineffective, stalls, illegal, byAction,
    friendlyFire, aoeWithFriends,
    playDecisions, playEnds, zeroScoreEnds, missedPositive,
    totalMs: ms,
    avgMs: games ? +(ms / games).toFixed(1) : 0,
    maxMs,
    decisionsPerSec: ms ? Math.round(decisions / (ms / 1000)) : 0,
    illegalSamples, missedSamples, crashSamples,
  };
}

function printReport(title, s) {
  const lines = [];
  lines.push('');
  lines.push(`== ${title}（${s.games} 局，seed ${s.seedBase} 起，aiLevel=${s.level}）==`);
  if (s.mode === '8p') {
    lines.push(`阵营胜率：主忠 ${s.winRate.lord}  反贼 ${s.winRate.rebel}  内奸 ${s.winRate.renegade}  平局/超时 ${s.winRate.draw}`);
  } else {
    const first = ((s.wins.lord + s.wins.loyalist) / (s.games || 1) * 100).toFixed(1);
    const second = ((s.wins.rebel / (s.games || 1)) * 100).toFixed(1);
    lines.push(`阵营胜率：先手(1号位/忠臣) ${first}%  后手(2号位/反贼) ${second}%`);
  }
  lines.push(`平均回合：${s.avgTurns}（中位 ${s.medianTurns}）   崩溃：${s.crashes}   超时：${s.timeouts}`);
  lines.push(`决策：共 ${s.totalDecisions} 次，每局平均 ${s.avgDecisions} 次；类型 ${JSON.stringify(s.decisionsByType)}`);
  lines.push(`动作：共 ${s.actions} 次；空转(无变化) ${s.noops}，无效(仅战报) ${s.ineffective}，连续重复空转 ${s.stalls}`);
  lines.push(`非法动作：${s.illegal}   友方伤害目标：${s.friendlyFire}   疑似友伤 AOE（友方≥敌方）：${s.aoeWithFriends}`);
  lines.push(`出牌结束：${s.playEnds}/${s.playDecisions}；全 0 分结束 ${s.zeroScoreEnds}；错过正分动作 ${s.missedPositive}`);
  const mix = Object.entries(s.byAction || {}).sort((a, b) => b[1].n - a[1].n).slice(0, 8);
  if (mix.length) lines.push('动作构成：' + mix.map(([k, d]) => `${k} ${d.n}`).join('，'));
  const offenders = Object.entries(s.byAction || {})
    .filter(([, d]) => d.ineffective > 0)
    .sort((a, b) => (b[1].ineffective - a[1].ineffective) || (b[1].n - a[1].n))
    .slice(0, 6);
  if (offenders.length) {
    lines.push('无效动作 Top：' + offenders.map(([k, d]) => `${k} ${d.ineffective}/${d.n}(空转${d.noop})`).join('，'));
  }
  lines.push(`耗时：总 ${s.totalMs}ms，平均 ${s.avgMs}ms/局，最长 ${s.maxMs}ms，吞吐 ${s.decisionsPerSec} 决策/秒`);
  if (s.crashSamples && s.crashSamples.length) {
    lines.push('崩溃样例：');
    for (const c of s.crashSamples) lines.push(`  - seed=${c.seed} ${String(c.stack).split('\n')[0]}`);
  }
  if (s.missedSamples && s.missedSamples.length) {
    lines.push('错过正分动作样例：' + s.missedSamples.map((x) => `[${x.seed}/${x.player}] ${x.action}(score ${x.score})`).join('；'));
  }
  if (s.illegalSamples.length) {
    lines.push('非法动作样例：');
    for (const x of s.illegalSamples) lines.push(`  - [${x.mode}/${x.seed}] ${x.type} ${x.player || ''} ${x.msg} reason=${trunc(x.reason || '', 60)} res=${trunc(x.res || '', 120)}`);
  }
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
(async () => {
  const out = { level: LEVEL, generatedAt: new Date().toISOString(), modes: {} };

  if (N8P > 0) {
    const results = [];
    for (let i = 0; i < N8P; i++) {
      const r = await runOne('8p', SEED8P + i);
      results.push(r);
      if (VERBOSE) console.log(`[8p ${i + 1}/${N8P}] seed=${r.seed} winner=${r.winner} turns=${r.turns} ms=${r.ms} decisions=${r.stats.decisions}`);
    }
    const s = summarize('8p', results, SEED8P);
    out.modes['8p'] = s;
    if (!JSON_OUT) printReport('八人身份局', s);
  }

  if (N1V1 > 0) {
    const results = [];
    for (let i = 0; i < N1V1; i++) {
      const r = await runOne('1v1', SEED1V1 + i);
      results.push(r);
      if (VERBOSE) console.log(`[1v1 ${i + 1}/${N1V1}] seed=${r.seed} winner=${r.winner} turns=${r.turns} ms=${r.ms} decisions=${r.stats.decisions}`);
    }
    const s = summarize('1v1', results, SEED1V1);
    out.modes['1v1'] = s;
    if (!JSON_OUT) printReport('单挑 1v1', s);
  }

  if (JSON_OUT) console.log(JSON.stringify(out, null, 2));

  let bad = 0;
  for (const k of Object.keys(out.modes)) {
    const s = out.modes[k];
    bad += s.crashes + s.timeouts + s.illegal;
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(2);
});
