#!/usr/bin/env node
/* 三国杀 · 单机版 — AI 视野审计（Proxy 拦截）
 *
 * 用法：
 *   node tools/ai_vision_check.js                 # 默认 5 模式 × 50 局
 *   node tools/ai_vision_check.js 5               # 5 局/模式（调试）
 *   node tools/ai_vision_check.js 50 --json       # 输出 JSON
 *
 * 原理：给每个 AI 一份只读 Proxy 视图（game / players / hand / deck / req），
 * 记录 AI 读取任何未公开信息的位置（ai.js 行号）。违规数必须为 0。
 *
 * 不修改真实游戏状态；Proxy 返回真实值以保证对局能跑完，但每次读取都会记录。
 */
'use strict';

const path = require('path');
const base = path.join(__dirname, '..', 'js');
for (const f of ['skilldesc', 'data', 'game', 'cards', 'skills', 'ai']) require(path.join(base, f + '.js'));
const SGS = globalThis.SGS;

const MODE_PLAYERS = { '8p': 8, '5p': 5, '1v1': 2, '2v2': 4, '3v3': 6, ddz: 3 };
const MODES = ['8p', '5p', '3v3', 'ddz', '1v1'];

function aiFrame() {
  const stack = String(new Error().stack || '').split('\n').slice(1);
  for (const line of stack) {
    const m = /(?:\(|\bat )([^()]*js[\\/]ai\.js):(\d+):\d+/.exec(line);
    if (m) return m[1].replace(/\\/g, '/').split('/').slice(-2).join('/') + ':' + m[2];
  }
  return 'unknown';
}

function makeReport() {
  const map = new Map();
  return {
    add(mode, seat, kind, field, detail) {
      const frame = aiFrame();
      const key = [mode, seat, kind, field, frame].join('|');
      let row = map.get(key);
      if (!row) {
        row = { mode, seat, kind, field, frame, detail: detail || '', count: 0 };
        map.set(key, row);
      }
      row.count += 1;
    },
    list() {
      return Array.from(map.values()).sort((a, b) => (a.mode + a.seat + a.field).localeCompare(b.mode + b.seat + b.field));
    },
  };
}

function makeVision(game, viewerSeat, report, mode) {
  const playerCache = new WeakMap();
  const proxyToRaw = new WeakMap();

  const isPublicRole = (q) => {
    if (!q) return false;
    if (q.seat === viewerSeat) return true;
    if (game.mode === '1v1' || game.teamMode || game.ddzMode) return true;
    if (q.seat === game.lordSeat) return true;
    if (q.revealed) return true;
    return false;
  };

  const hiddenCard = (card, pathLabel) => {
    if (!card || typeof card !== 'object') return card;
    return new Proxy(card, {
      get(t, prop) {
        if (prop === 'id' || prop === 'cardId' || prop === Symbol.toStringTag) return Reflect.get(t, prop);
        report.add(mode, viewerSeat, 'hidden-card', pathLabel + '.' + String(prop),
          '读取未公开牌：' + (t && t.id != null ? ('id=' + t.id) : ''));
        return Reflect.get(t, prop);
      },
      set(t, prop, v) { return Reflect.set(t, prop, v); },
    });
  };

  const hiddenArray = (arr, pathLabel, wrapItem) => {
    if (!Array.isArray(arr)) return arr;
    return new Proxy(arr, {
      get(t, prop) {
        if (prop === 'length') return t.length;
        if (prop === 'constructor') return Array;
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          report.add(mode, viewerSeat, 'hidden-array', pathLabel + '[' + prop + ']', '读取未公开数组元素');
          return wrapItem ? wrapItem(t[Number(prop)]) : t[Number(prop)];
        }
        if (prop === Symbol.iterator) {
          report.add(mode, viewerSeat, 'hidden-array', pathLabel + '[Symbol.iterator]', '遍历未公开数组');
          return function () { return t[Symbol.iterator](); };
        }
        if (typeof prop === 'string' && ['map', 'filter', 'find', 'forEach', 'some', 'every', 'reduce', 'slice', 'indexOf', 'includes', 'join', 'entries', 'values', 'keys', 'findIndex', 'sort', 'concat'].indexOf(prop) >= 0) {
          report.add(mode, viewerSeat, 'hidden-array', pathLabel + '.' + prop, '调用未公开数组方法');
          return t[prop].bind(t);
        }
        return Reflect.get(t, prop);
      },
    });
  };

  const wrapPlayer = (raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    if (playerCache.has(raw)) return playerCache.get(raw);
    const other = raw.seat !== viewerSeat;
    const p = new Proxy(raw, {
      get(t, prop) {
        if (prop === 'role') {
          if (!isPublicRole(t)) {
            report.add(mode, viewerSeat, 'hidden-role', 'players[' + t.seat + '].role', '读取未公开身份');
          }
          return Reflect.get(t, prop);
        }
        if (prop === 'hand') {
          if (!other) return Reflect.get(t, prop);
          return hiddenArray(t.hand, 'players[' + t.seat + '].hand', (c) => hiddenCard(c, 'players[' + t.seat + '].hand[]'));
        }
        if (other && (prop === 'marks' || prop === 'roleMark' || prop === 'identityMark' || prop === 'notes' || prop === 'note')) {
          report.add(mode, viewerSeat, 'hidden-mark', 'players[' + t.seat + '].' + String(prop), '读取其他玩家的标记/笔记');
          return Reflect.get(t, prop);
        }
        if (other && prop === 'seatHand') {
          report.add(mode, viewerSeat, 'hidden-hand', 'players[' + t.seat + '].seatHand', '');
        }
        return Reflect.get(t, prop);
      },
      set(t, prop, v) { return Reflect.set(t, prop, v); },
    });
    playerCache.set(raw, p);
    proxyToRaw.set(p, raw);
    return p;
  };

  const wrapPlayerArray = (arr, label) => {
    if (!Array.isArray(arr)) return arr;
    return new Proxy(arr, {
      get(t, prop) {
        if (prop === 'length') return t.length;
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return wrapPlayer(t[Number(prop)]);
        if (prop === Symbol.iterator) return function () { return t.map(wrapPlayer)[Symbol.iterator](); };
        if (typeof prop === 'string' && ['map', 'filter', 'find', 'forEach', 'some', 'every', 'reduce', 'slice', 'sort', 'concat', 'findIndex'].indexOf(prop) >= 0) {
          return function (...args) {
            const mapped = t.map(wrapPlayer);
            const cb = args[0];
            if (typeof cb === 'function') args[0] = (q, i, a) => cb(q, i, mapped);
            return mapped[prop].apply(mapped, args);
          };
        }
        return Reflect.get(t, prop);
      },
    });
  };

  const unwrap = (v) => (v && proxyToRaw.has(v)) ? proxyToRaw.get(v) : v;

  const gameProxy = new Proxy(game, {
    get(target, prop, receiver) {
      if (prop === 'players') return wrapPlayerArray(target.players, 'players');
      if (prop === 'alivePlayers') return wrapPlayerArray(target.alivePlayers, 'alivePlayers');
      if (prop === 'lord') return target.lord ? wrapPlayer(target.lord) : null;
      if (prop === 'deck') {
        return hiddenArray(target.deck, 'deck', (c) => hiddenCard(c, 'deck[]'));
      }
      if (prop === 'pendingRequest') {
        report.add(mode, viewerSeat, 'hidden-request', 'game.pendingRequest', '读取原始 pending 请求');
        return target.pendingRequest;
      }
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return function (...args) {
        const rawArgs = args.map((a) => {
          if (a && proxyToRaw.has(a)) return proxyToRaw.get(a);
          return a;
        });
        if (prop === 'allCardsOf' && rawArgs[0] && rawArgs[0].seat !== viewerSeat) {
          report.add(mode, viewerSeat, 'hidden-cards', 'game.allCardsOf(players[' + rawArgs[0].seat + '])', '引擎返回他人手牌内容');
        }
        if ((prop === 'canUseSlash' || prop === 'findCard') && rawArgs[0] && rawArgs[0].seat != null && rawArgs[0].seat !== viewerSeat) {
          report.add(mode, viewerSeat, 'hidden-cards', 'game.' + prop + '(players[' + rawArgs[0].seat + '])', '');
        }
        return v.apply(target, rawArgs);
      };
    },
  });

  return { game: gameProxy, wrapPlayer, hiddenArray, hiddenCard };
}

function scanRequest(req, game, viewerSeat, report, mode) {
  if (!req) return req;
  const hidden = new Map();
  for (const p of game.players) {
    if (!p || p.seat === viewerSeat) continue;
    for (const c of (p.hand || [])) if (c && c.id != null) hidden.set(c.id, p.seat);
  }
  const owners = (list) => {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const x of list) {
      const id = x && typeof x === 'object' ? x.id : x;
      if (hidden.has(id)) out.push({ id, seat: hidden.get(id) });
    }
    return out;
  };
  const cardLeak = owners(req.cards);
  if (cardLeak.length) report.add(mode, viewerSeat, 'request-cards', 'req.cards', '请求携带他人手牌 ' + JSON.stringify(cardLeak.slice(0, 5)));
  const optionLeak = owners((req.options || []).map((o) => o && o.cardId != null ? { id: o.cardId } : o));
  if (optionLeak.length) report.add(mode, viewerSeat, 'request-options', 'req.options', JSON.stringify(optionLeak.slice(0, 5)));
  for (const k of ['deck', 'judgeCard', 'pindianCard', 'otherCard', 'hiddenCard', 'targetHand']) {
    if (req[k] != null) report.add(mode, viewerSeat, 'request-field', 'req.' + k, '请求包含未公开字段');
  }
  return req;
}

async function runOneGame(mode, seed, report, stats) {
  const n = MODE_PLAYERS[mode] || 8;
  const game = new SGS.Game({
    mode, seed, humanSeat: -1, agents: [], paceFactor: 0, mulligan: false,
    onUpdate() {},
  });
  game.pause = async () => {};
  const agents = [];
  for (let seat = 0; seat < n; seat++) {
    const vision = makeVision(game, seat, report, mode);
    const ai = new SGS.AI(vision.game, seat, { speed: 0, aiLevel: 'normal' });
    agents.push({
      decide(req) {
        scanRequest(req, game, seat, report, mode);
        const reqProxy = new Proxy(req || {}, {
          get(t, prop) {
            if (prop === 'player') return t.player ? vision.wrapPlayer(t.player) : null;
            if ((prop === 'cards' || prop === 'options') && Array.isArray(t[prop])) {
              return t[prop].map((x) => {
                if (!x || typeof x !== 'object') return x;
                const id = x.id != null ? x.id : x.cardId;
                const otherOwner = (() => {
                  for (const p of game.players) {
                    if (p.seat === seat) continue;
                    if ((p.hand || []).some((c) => c && c.id === id)) return p.seat;
                  }
                  return null;
                })();
                return otherOwner == null ? x : vision.hiddenCard(x, prop + '[]');
              });
            }
            return Reflect.get(t, prop);
          },
        });
        return ai.decide(reqProxy);
      },
    });
  }
  game.agents = agents;
  await game.start();
  stats.games += 1;
  stats.turns += game.turnCount || 0;
  return game;
}

async function runVisionAudit(opts = {}) {
  const games = opts.games == null ? 50 : Math.max(1, Number(opts.games) || 1);
  const modes = opts.modes || MODES;
  const report = makeReport();
  const stats = { games: 0, turns: 0, errors: [] };
  const t0 = Date.now();
  for (const mode of modes) {
    const n = MODE_PLAYERS[mode] || 8;
    for (let i = 0; i < games; i++) {
      try {
        await runOneGame(mode, 7000 + i * 37 + n * 11, report, stats);
      } catch (e) {
        stats.errors.push({ mode, seed: 7000 + i * 37 + n * 11, error: e && e.stack || String(e) });
      }
    }
    if (opts.onMode) opts.onMode(mode);
  }
  const violations = report.list();
  return {
    games: stats.games, turns: stats.turns, ms: Date.now() - t0,
    modes, gamesPerMode: games,
    violations, errors: stats.errors,
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.indexOf('--json') >= 0;
  const positional = args.filter((a) => !a.startsWith('--'));
  const games = positional[0] == null ? 50 : Number(positional[0]);
  runVisionAudit({ games }).then((res) => {
    if (json) {
      console.log(JSON.stringify(res, null, 1));
    } else {
      console.log('[AI-VISION] games=' + res.games + ' modes=' + res.modes.join('/') + ' × ' + res.gamesPerMode + ' turns=' + res.turns + ' ms=' + res.ms);
      if (res.errors.length) {
        console.log('[AI-VISION] ERRORS ' + res.errors.length);
        res.errors.slice(0, 3).forEach((e) => console.log('  ' + e.mode + ' seed=' + e.seed + ' ' + String(e.error).split('\n')[0]));
      }
      console.log('[AI-VISION] VIOLATIONS ' + res.violations.length);
      res.violations.slice(0, 80).forEach((v) => {
        console.log('  ' + v.mode + ' seat=' + v.seat + ' [' + v.kind + '] ' + v.field + ' @' + v.frame + ' ×' + v.count + (v.detail ? (' — ' + v.detail) : ''));
      });
    }
    process.exit(res.violations.length || res.errors.length ? 1 : 0);
  }).catch((e) => { console.error('HARNESS ERROR', e && e.stack || e); process.exit(2); });
}

module.exports = { runVisionAudit };
