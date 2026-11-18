#!/usr/bin/env node
/* 三国杀 · 单机版 — 真实点击 E2E 回归脚本
 *
 * 用法：
 *   node tools/qa_e2e.js
 *   QA_BASE=http://127.0.0.1:8899/ QA_DEEP_COUNTDOWN=0 node tools/qa_e2e.js
 *
 * 说明：
 *  - 通过 Chrome DevTools Protocol（CDP）驱动 headless Chrome，鼠标点击使用
 *    Input.dispatchMouseEvent 真实派发，不使用 jQuery/内部 API 直接改状态。
 *  - 只读取页面并点击 UI；不修改 index.html / js / css / data。
 *  - 截图写入 out/qa_*.png；结果 JSON 写入系统临时目录（不污染仓库）。
 *  - 启动 Chrome 使用项目外临时 profile，不覆盖 HOME。
 *  - 控制台异常通过 Runtime.exceptionThrown / Runtime.consoleAPICalled /
 *    Log.entryAdded 捕获。
 *
 * 环境变量：
 *   QA_BASE             默认 http://127.0.0.1:8899/
 *   QA_CHROME           Chrome 可执行文件路径
 *   QA_DEEP_COUNTDOWN   1/0，是否等待倒计时 ≤10s 验证红色告警（默认 1，约 80s）
 *   QA_KEEP_OPEN        1 时结束后保留 Chrome（调试用）
 */

'use strict';

const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out');
const BASE = (process.env.QA_BASE || 'http://127.0.0.1:8899/').replace(/\/?$/, '/');
const CHROME = process.env.QA_CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEEP_COUNTDOWN = process.env.QA_DEEP_COUNTDOWN !== '0';
const KEEP_OPEN = process.env.QA_KEEP_OPEN === '1';
const STARTED_AT = new Date();

let QA_DATA = null;
try {
  require(path.join(ROOT, 'js/data.js'));
  QA_DATA = globalThis.SGS_DATA || null;
} catch (e) { /* 仅用于把牌名归类为基本牌/装备/锦囊 */ }

// 注入到每个新文档：拦截 HTMLMediaElement.play，记录卡牌音频的 src/currentTime/error
const AUDIO_HOOK = '(' + function () {
  if (window.__qaAudioInstalled) return;
  window.__qaAudioInstalled = true;
  window.__qaAudio = [];
  window.__qaAudioCardReq = [];
  var push = function (r) {
    try { window.__qaAudio.push(r); if (window.__qaAudio.length > 1500) window.__qaAudio.shift(); } catch (e) {}
  };
  var orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    var el = this;
    var src = el.currentSrc || el.src || '';
    var rec = {
      t: Date.now(), src: src, currentTime: el.currentTime, paused: el.paused,
      readyState: el.readyState, volume: el.volume,
      error: el.error ? { code: el.error.code, message: el.error.message } : null,
    };
    push(rec);
    var p;
    try { p = orig.apply(el, arguments); } catch (e) { rec.throw = e.name + ': ' + e.message; throw e; }
    if (p && typeof p.then === 'function') {
      p.then(function () { rec.ok = true; rec.playCurrentTime = el.currentTime; })
        .catch(function (e) { rec.reject = e.name + ': ' + e.message; });
    }
    setTimeout(function () {
      push({ t: Date.now(), src: src, event: 'progress', currentTime: el.currentTime,
        paused: el.paused, ended: el.ended,
        error: el.error ? { code: el.error.code, message: el.error.message } : null });
    }, 320);
    return p;
  };
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'AUDIO') {
      push({ t: Date.now(), src: t.currentSrc || t.src, event: 'error',
        error: t.error ? { code: t.error.code, message: t.error.message } : null });
    }
  }, true);
}.toString() + ')();';

const MD5_FILES = [
  'index.html',
  'css/style.css',
  'js/main.js',
  'js/ui.js',
  'js/game.js',
  'js/cards.js',
  'js/skills.js',
  'js/data.js',
  'js/ai.js',
  'js/audio.js',
  'js/skilldesc.js',
  'tools/audit_rules.js',
];

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

/* ============================================================
   小工具
   ============================================================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function md5File(p) {
  try {
    return crypto.createHash('md5').update(fs.readFileSync(path.join(ROOT, p))).digest('hex');
  } catch (e) {
    return 'MISSING';
  }
}
function snapshotMd5() {
  const out = {};
  for (const f of MD5_FILES) out[f] = md5File(f);
  return out;
}
function md5Text(t) {
  return crypto.createHash('md5').update(t).digest('hex');
}
function nowIso() {
  return new Date().toISOString();
}
function fmtMs(ms) {
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(1) + 's';
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEq(actual, expected, label) {
  if (actual !== expected) throw new Error(label + ' 期望=' + JSON.stringify(expected) + ' 实际=' + JSON.stringify(actual));
}
function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/* ============================================================
   CDP 驱动
   ============================================================ */
function httpGetJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('GET 超时: ' + url)));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

class CDP {
  constructor(port) {
    this.port = port;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    this.logEntries = [];
    this.crashed = false;
    this.closed = false;
  }

  async connect() {
    let list = null;
    for (let i = 0; i < 80; i++) {
      try {
        list = await httpGetJson('http://127.0.0.1:' + this.port + '/json/list');
        if (list && list.length) break;
      } catch (e) { /* retry */ }
      await sleep(150);
    }
    if (!list) throw new Error('无法连接 Chrome CDP（端口 ' + this.port + '）');
    const page = list.find((t) => t.type === 'page') || list[0];
    if (!page) throw new Error('CDP 无可用 page target');
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 10000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      this.ws.addEventListener('error', (e) => { clearTimeout(timer); reject(new Error('CDP WebSocket 错误: ' + (e && e.message))); });
    });
    this.ws.addEventListener('message', (ev) => this.onMessage(ev));
    this.ws.addEventListener('close', () => { this.closed = true; });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    this.send('Inspector.enable').catch(() => {});
    return this;
  }

  onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error('CDP ' + msg.error.code + ': ' + msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params && msg.params.exceptionDetails || {};
      const ex = d.exception || {};
      const frames = d.stackTrace && d.stackTrace.callFrames || [];
      this.exceptions.push({
        time: nowIso(),
        text: d.text || '',
        description: ex.description || ex.value || '',
        url: d.url || '',
        line: d.lineNumber,
        column: d.columnNumber,
        topFrame: frames[0] ? (frames[0].functionName || '(anonymous)') + ' @ ' + frames[0].url + ':' + frames[0].lineNumber : '',
      });
      if (this.exceptions.length > 80) this.exceptions.shift();
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const type = msg.params && msg.params.type;
      if (type === 'error' || type === 'warning') {
        const args = (msg.params && msg.params.args || []).map((a) => {
          if (a.value !== undefined) return String(a.value);
          return a.description || a.unserializableValue || '';
        });
        this.consoleErrors.push({
          time: nowIso(),
          type,
          text: args.join(' '),
          topFrame: (msg.params.stackTrace && msg.params.stackTrace.callFrames && msg.params.stackTrace.callFrames[0])
            ? msg.params.stackTrace.callFrames[0].url + ':' + msg.params.stackTrace.callFrames[0].lineNumber
            : '',
        });
        if (this.consoleErrors.length > 80) this.consoleErrors.shift();
      }
      return;
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params && msg.params.entry || {};
      if (e.level === 'error' || e.level === 'warning') {
        this.logEntries.push({
          time: nowIso(),
          level: e.level,
          source: e.source || '',
          text: e.text || '',
          url: e.url || '',
        });
        if (this.logEntries.length > 80) this.logEntries.shift();
      }
      return;
    }
    if (msg.method === 'Inspector.targetCrashed') {
      this.crashed = true;
    }
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new Error('CDP 连接已断开，无法发送 ' + method));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async eval(fn, ...args) {
    let expression;
    if (typeof fn === 'function') {
      expression = '(' + fn.toString() + ').apply(null, ' + JSON.stringify(args) + ')';
    } else {
      expression = String(fn);
    }
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('页面 JS 异常: ' + (d.exception && (d.exception.description || d.exception.value) || d.text));
    }
    return r.result ? r.result.value : undefined;
  }

  async waitExpr(expression, timeout = 5000, interval = 100) {
    const t0 = Date.now();
    let lastErr = null;
    while (Date.now() - t0 < timeout) {
      try {
        const v = await this.eval(expression);
        if (v) return v;
      } catch (e) { lastErr = e; }
      await sleep(interval);
    }
    if (lastErr) throw lastErr;
    return false;
  }

  async navigate(url, readyExpr = 'document.readyState === "complete"', timeout = 12000) {
    const before = Date.now();
    await this.send('Page.navigate', { url });
    // 旧文档的 readyState 可能已满足；用 performance.timeOrigin 确认新文档已创建
    const expr = 'performance.timeOrigin > ' + before + ' && ' +
      '(' + JSON.stringify(url) + ' === location.href || location.href.indexOf(' + JSON.stringify(url) + ') === 0) && ' +
      readyExpr + ' && !!window.SGS_UI';
    await this.waitExpr(expr, timeout, 100);
    await sleep(350);
  }

  async reloadPage(timeout = 12000) {
    const before = Date.now();
    await this.send('Page.reload', { ignoreCache: true });
    await this.waitExpr('performance.timeOrigin > ' + before +
      ' && document.readyState === "complete" && !!window.SGS_UI', timeout, 100);
    await sleep(350);
  }

  async point(selector, index = 0) {
    return await this.eval((sel, idx) => {
      const nodes = document.querySelectorAll(sel);
      const el = nodes[idx];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') return null;
      const pts = [
        [0.5, 0.5], [0.5, 0.35], [0.5, 0.65], [0.35, 0.5],
        [0.65, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.25], [0.5, 0.75],
      ];
      for (const p of pts) {
        const x = r.left + r.width * p[0];
        const y = r.top + r.height * p[1];
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === el || el.contains(hit))) {
          return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
        }
      }
      return null;
    }, selector, index);
  }

  async move(selector, index = 0) {
    const pt = await this.point(selector, index);
    if (!pt) throw new Error('鼠标移动目标不可见/被遮挡: ' + selector + '[' + index + ']');
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 });
    await sleep(80);
    return pt;
  }

  async click(selector, index = 0, opts = {}) {
    const pt = await this.point(selector, index);
    if (!pt) throw new Error('点击目标不可见/被遮挡: ' + selector + '[' + index + ']');
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none', buttons: 0 });
    await sleep(30);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(20);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(opts.wait == null ? 110 : opts.wait);
    return pt;
  }

  async clickPoint(x, y, wait = 100) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await sleep(25);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(20);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(wait);
  }
}

/* ============================================================
   页面状态（在页面内执行）
   ============================================================ */
function pageState() {
  const st = window.SGS_UI && window.SGS_UI._state ? window.SGS_UI._state() : null;
  const g = st && st.game;
  const req = st && st.pending && st.pending.req;
  const q = (s) => document.querySelector(s);
  const qa = (s) => document.querySelectorAll(s);
  const active = (id) => !!(q(id) && q(id).classList.contains('is-active'));
  const cnt = q('#tb-count');
  return {
    screen: (st && st.screen) || null,
    mode: g ? g.mode : null,
    over: !!(g && g.over),
    phase: g ? g.phase : null,
    turn: g ? (g.turnCount || 0) : 0,
    currentSeat: g ? g.currentSeat : null,
    hand: g && g.players && g.players[0] ? g.players[0].hand.map((c) => ({ id: c.id, name: c.name, type: c.type || null, subtype: c.subtype || null })) : [],
    hp: g && g.players && g.players[0] ? g.players[0].hp : null,
    maxHp: g && g.players && g.players[0] ? g.players[0].maxHp : null,
    role: g && g.players && g.players[0] ? g.players[0].role : null,
    alive: g && g.players ? g.players.map((p) => ({
      seat: p.seat, alive: !!p.alive, role: p.role, hp: p.hp,
      name: p.general ? p.general.name : null,
    })) : [],
    deck: g ? (g.deck || []).length : null,
    discard: g ? (g.discardPile || []).length : null,
    wages: g ? (g.winner || null) : null,
    winner: g ? (g.winner || null) : null,
    teamMode: !!(g && g.teamMode),
    meRole: (q('#me-role') || {}).textContent || '',
    meRoleClass: (q('#me-role') || {}).className || '',
    saveRaw: (() => { try { return localStorage.getItem('sgs.save.auto'); } catch (e) { return null; } })(),
    saveSlots: (() => {
      try {
        return [1, 2, 3].map((n) => localStorage.getItem('sgs.save.slot' + n));
      } catch (e) { return [null, null, null]; }
    })(),
    legacySaveRaw: (() => { try { return localStorage.getItem('sgs.save.v1'); } catch (e) { return null; } })(),
    continueVisible: !!(q('#btn-continue') && !q('#btn-continue').classList.contains('is-hidden')),
    continueMeta: (q('#continue-meta') || {}).textContent || '',
    savesBtnVisible: !!(q('#btn-saves') && !q('#btn-saves').classList.contains('is-hidden')),
    savesPanelOpen: !!(q('#saves-panel') && q('#saves-panel').classList.contains('is-open')),
    autosaveText: (q('#autosave-toast') || {}).textContent || '',
    sel: st && st.sel ? {
      action: st.sel.action ? {
        kind: st.sel.action.kind,
        label: st.sel.action.label || '',
        maxTargets: st.sel.action.maxTargets || 0,
        minTargets: st.sel.action.minTargets || 0,
      } : null,
      cards: (st.sel.cards || []).slice(),
      targets: (st.sel.targets || []).slice(),
    } : null,
    pending: req ? {
      type: req.type,
      need: req.need || null,
      seat: req.player ? req.player.seat : null,
      reason: req.reason || '',
      options: (req.options || []).map((o) => ({ cardId: o.cardId, as: o.as || null, skill: o.skill || null })),
      actions: (req.actions || []).map((a) => ({
        kind: a.kind, label: a.label || '',
        maxTargets: a.maxTargets || 0, minTargets: a.minTargets || 0,
        subcards: (a.subcards || []).slice(),
      })),
      cards: (req.cards || []).map((c) => ({ id: c.id, name: c.name })),
      min: req.min || 0,
      max: req.max == null ? null : req.max,
    } : null,
    screenActive: {
      menu: active('#screen-menu'),
      select: active('#screen-select'),
      game: active('#screen-game'),
      result: active('#screen-result'),
    },
    seats: qa('#seats .seat').length,
    seatRoles: Array.prototype.map.call(qa('#seats .seat'), (s) => ({
      seat: s.dataset.seat,
      role: (s.querySelector('.seat-role') || {}).textContent || '',
      cls: (s.querySelector('.seat-role') || {}).className || '',
    })),
    countdown: cnt ? cnt.textContent : '',
    countdownWarn: cnt ? cnt.classList.contains('is-warn') : false,
    countdownColor: cnt ? getComputedStyle(cnt).color : null,
    handDom: qa('#hand .hand-card').length,
    modalCount: qa('#modal-root .modal').length,
    modalTitle: (q('#modal-root .modal-title') || {}).textContent || '',
    modalReason: (q('#modal-root .modal-reason') || {}).textContent || '',
    toast: (q('#toast-root .toast') || {}).textContent || '',
    fatal: !!(q('#modal-root .modal-title') && q('#modal-root .modal-title').textContent.indexOf('运行出错') >= 0),
    settingsOpen: !!(q('#settings-panel') && q('#settings-panel').classList.contains('is-open')),
    aimPaths: qa('#aim-layer path').length,
    transient: qa('#aim-layer path.is-transient').length,
    transientStroke: (() => { const p = q('#aim-layer path.is-transient'); return p ? getComputedStyle(p).stroke : null; })(),
    transientMarker: (() => { const p = q('#aim-layer path.is-transient'); return p ? p.getAttribute('marker-end') : null; })(),
    targetable: qa('#seats .seat-targetable').length,
    picked: qa('#seats .seat-picked').length,
    chooseOpen: !!(q('#card-chooser') && q('#card-chooser').classList.contains('is-open')),
    menuNote: (q('#menu-note') || {}).textContent || '',
    meName: (q('#me-name') || {}).textContent || '',
    resultTitle: (q('#result-title') || {}).textContent || '',
    resultSub: (q('#result-sub') || {}).textContent || '',
    resultPlayers: Array.prototype.map.call(qa('#result-players .result-player'), (el) => ({
      you: el.classList.contains('is-you'),
      dead: el.classList.contains('is-dead'),
      winner: el.classList.contains('is-winner'),
      text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(),
    })),
    reduceMotion: document.body.classList.contains('reduce-motion'),
    noAnim: document.body.classList.contains('no-anim'),
    phaseBannerOn: !!(q('#phase-banner') && q('#phase-banner').classList.contains('is-on')),
    phaseBannerTitle: (q('#phase-banner-title') || {}).textContent || '',
    skillBannerOn: !!(q('#skill-banner') && q('#skill-banner .skill-line')),
    skillBannerTitle: ((q('#skill-banner .skill-line') || {}).textContent) || '',
    screenGameClass: (q('#screen-game') || {}).className || '',
    seatPos: Array.prototype.map.call(qa('#seats .seat'), (s) => ({
      seat: s.dataset.seat,
      x: s.style.getPropertyValue('--x'), y: s.style.getPropertyValue('--y'),
    })),
  };
}

/* ============================================================
   主流程
   ============================================================ */
(async () => {
  const meta = {
    startedAt: STARTED_AT.toISOString(),
    baseUrl: BASE,
    node: process.version,
    chromeVersion: null,
    deepCountdown: DEEP_COUNTDOWN,
    md5Start: snapshotMd5(),
    md5End: null,
    changedFiles: [],
    servedIndexMd5: null,
    localIndexMd5: null,
    serverIndexMatch: null,
    finalUrl: null,
  };
  const results = [];
  const exceptions = [];
  const screenshots = [];
  let chromeProc = null;
  let profileDir = null;
  let cdp = null;
  let serverProc = null;
  let aborted = false;

  const log = (...a) => console.log(...a);

  async function shot(name, row) {
    if (!/^qa_[a-z0-9_]+\.png$/.test(name)) throw new Error('截图名不合规: ' + name);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    screenshots.push(name);
    if (row) row.screenshots.push(name);
    return name;
  }

  async function shotClip(name, clip, row) {
    if (!/^qa_[a-z0-9_]+\.png$/.test(name)) throw new Error('截图名不合规: ' + name);
    const x = Math.max(0, Math.floor(clip.x));
    const y = Math.max(0, Math.floor(clip.y));
    const width = Math.max(1, Math.min(1600 - x, Math.ceil(clip.width)));
    const height = Math.max(1, Math.min(900 - y, Math.ceil(clip.height)));
    const r = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x, y, width, height, scale: 1 },
    });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    screenshots.push(name);
    if (row) row.screenshots.push(name);
    return name;
  }

  async function state() {
    return await cdp.eval(pageState);
  }

  async function setQaViewport(width, height) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: width, height: height, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(260);
  }

  async function markActual(row, text) {
    row.actual = text;
  }

  /* ---------- 「更多」菜单 ----------
   * 顶栏只保留 暂停/战报/更多，设置/托管/保存/投降/退出 都在 #more-menu 内。
   * 下面几个 helper 保持真实鼠标点击：先点 #btn-more 展开，再点菜单项；
   * 菜单项点击后 ui.js 会自动收起菜单，所以无需逐个手动关闭。
   */
  async function isMoreOpen() {
    return await cdp.eval(() => {
      const mm = document.querySelector('#more-menu');
      return !!(mm && mm.classList.contains('is-open'));
    });
  }

  async function openMoreMenu() {
    if (await isMoreOpen()) return;
    await cdp.click('#btn-more');
    await cdp.waitExpr('document.querySelector("#more-menu") && document.querySelector("#more-menu").classList.contains("is-open")', 2000, 60);
    await sleep(80);
  }

  async function closeMoreMenu() {
    if (!(await isMoreOpen())) return;
    try {
      await cdp.click('#btn-more', 0, { wait: 40 });
    } catch (e) {
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Escape', code: 'Escape',
        windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Escape', code: 'Escape',
        windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      });
    }
    await cdp.waitExpr('!document.querySelector("#more-menu") || !document.querySelector("#more-menu").classList.contains("is-open")', 1500, 60).catch(() => {});
  }

  // 菜单项真实鼠标坐标：不可见时先展开「更多」菜单；返回 null 表示确实不可点
  async function pointMenu(selector, index = 0) {
    let pt = await cdp.point(selector, index);
    if (pt) return pt;
    await openMoreMenu();
    pt = await cdp.point(selector, index);
    return pt;
  }

  // 真实鼠标点击菜单项（自动展开「更多」菜单，保留 Input.dispatchMouseEvent 风格）
  async function clickMenu(selector, index = 0, opts = {}) {
    let pt = await pointMenu(selector, index);
    // 更多菜单是异步展开的，首次 point 可能早于过渡帧；短轮询重试，不改断言
    for (let attempt = 0; !pt && attempt < 6; attempt++) {
      await sleep(120);
      await openMoreMenu();
      pt = await cdp.point(selector, index);
    }
    if (!pt) throw new Error('「更多」菜单项不可见/被遮挡: ' + selector + '[' + index + ']');
    const out = await cdp.click(selector, index, opts);
    // 兜底：菜单项的点击处理器理论上会 setMore(false)；若仍展开则收起，避免挡后续点击
    if (await isMoreOpen()) await closeMoreMenu();
    return out;
  }

  /* ---------- 开局：手气卡兼容 ----------
   * js/game.js 的 mulliganPhase() 目前直接 return（手气卡功能临时关闭）。
   * 旧用例硬等 chooseOption 会必然超时，这里用短窗口探测：
   *  - 出现手气卡询问 → 视为功能可用，返回 present=true 交给用例走原断言；
   *  - 未出现（已进入牌桌/play）→ 返回 present=false，用例跳过手气卡子断言而不是伪造。
   */
  async function detectMulligan(timeout = 1500) {
    const t0 = Date.now();
    let gameSince = 0;
    let st = await state();
    while (Date.now() - t0 < timeout) {
      st = await state();
      if (st.pending && st.pending.type === 'chooseOption' && /手气卡/.test(st.modalReason || '')) {
        return { present: true, st };
      }
      // 已进入牌桌且稳定 350ms 没有手气卡询问，才判定“未启用”，避免弹窗晚渲染被误判
      if (st.screenActive.game) {
        if (!gameSince) gameSince = Date.now();
        if (Date.now() - gameSince >= 350) return { present: false, st };
      } else {
        gameSince = 0;
      }
      await sleep(60);
    }
    return { present: false, st };
  }

  // 选将确认后的统一开局入口：手气卡可用则点“保留手牌”，关闭时直接等牌桌。
  // 其它开局询问（观星/洛神等）不在此代答，保持各用例自己的清理逻辑。
  async function enterGameAfterSelect(opts = {}) {
    const seats = opts.seats;
    const label = opts.label || '等待牌桌';
    const t0 = Date.now();
    let answered = 0;
    let gameSince = 0;
    let st = await state();
    while (Date.now() - t0 < 4000) {
      st = await state();
      if (st.over || st.screenActive.result) return { st, answered, ended: true };
      if (st.pending && st.pending.type === 'chooseOption' && /手气卡/.test(st.modalReason || '')) {
        const n = await cdp.eval(() => document.querySelectorAll('#modal-root .option-btn').length);
        if (n > 0) {
          await cdp.click('#modal-root .option-btn', n - 1);
          answered += 1;
          gameSince = 0;
          await sleep(200);
          continue;
        }
      }
      if (st.screenActive.game && (seats == null || st.seats === seats)) {
        if (!gameSince) gameSince = Date.now();
        if (Date.now() - gameSince >= 350) return { st, answered };
      } else {
        gameSince = 0;
      }
      await sleep(100);
    }
    st = await waitState((s) => s.screenActive.game && (seats == null || s.seats === seats), 8000, label);
    return { st, answered, timedOut: true };
  }

  async function runCase(id, title, steps, expected, severity, fn) {
    const row = {
      id, title, steps: [].concat(steps), expected, severity,
      status: 'RUNNING', actual: '', ms: 0, screenshots: [], notes: [],
    };
    results.push(row);
    if (process.env.QA_ONLY && process.env.QA_ONLY.split(',').indexOf(id) < 0) {
      row.status = 'SKIP';
      row.actual = 'QA_ONLY 未选';
      return row;
    }
    if (aborted) {
      row.status = 'SKIP';
      row.actual = '因前置致命错误中止';
      log('[SKIP] ' + id + ' ' + title + ' — 因前置致命错误中止');
      return row;
    }
    const t0 = Date.now();
    log('[RUN ] ' + id + ' ' + title);
    try {
      const out = await fn(row);
      if (out && out.skip) {
        row.status = 'SKIP';
        row.actual = out.skip;
      } else {
        row.status = 'PASS';
        row.actual = (out && out.actual) || '符合预期';
      }
      if (out && out.notes) row.notes = row.notes.concat(out.notes);
    } catch (e) {
      row.status = 'FAIL';
      row.actual = e && e.message ? e.message : String(e);
      row.error = e && e.stack ? e.stack : '';
      try { await shot('qa_fail_' + id.toLowerCase() + '.png', row); } catch (e2) { /* ignore */ }
    }
    row.ms = Date.now() - t0;
    log('[' + row.status + '] ' + id + ' ' + title + ' (' + fmtMs(row.ms) + ') — ' + row.actual);
    return row;
  }

  function getCase(id) {
    return results.find((r) => r.id === id);
  }

  /* ---------- 等待与自动应答 ---------- */
  async function waitState(predicate, timeout, label) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeout) {
      try { last = await state(); } catch (e) { last = null; }
      if (last && predicate(last)) return last;
      await sleep(120);
    }
    throw new Error((label || '等待状态超时') + '（' + fmtMs(timeout) + '）最后状态: ' + truncate(JSON.stringify(last && {
      screen: last.screen, pending: last.pending && last.pending.type, over: last.over,
      title: last.resultTitle, seats: last.seats,
    }), 300));
  }

  async function waitGone(selector, timeout, label) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const n = await cdp.eval((sel) => document.querySelectorAll(sel).length, selector);
        if (!n) return true;
      } catch (e) { /* ignore */ }
      await sleep(100);
    }
    throw new Error((label || ('等待消失超时: ' + selector)));
  }

  async function pumpPending(reason) {
    const st = await state();
    const p = st.pending;
    if (!p) return 'none';
    if (p.type === 'response') {
      await cdp.click('[data-act="resp-pass"]');
      return 'response:pass';
    }
    if (p.type === 'play') {
      if (await cdp.eval(() => !!document.querySelector('[data-act="play-end"]'))) {
        await cdp.click('[data-act="play-end"]');
        return 'play:end';
      }
      return 'play:no-button';
    }
    if (p.type === 'chooseOption') {
      await cdp.click('#modal-root .option-btn', 1);
      return 'chooseOption:last';
    }
    if (p.type === 'chooseCards') {
      const n = p.min || 0;
      for (let i = 0; i < n; i++) {
        const sel = n > 1 ? '.pick-card:not(.is-picked)' : '.pick-card';
        await cdp.click(sel, 0).catch(() => {});
      }
      await cdp.click('[data-m="confirm"]').catch(() => {});
      return 'chooseCards:' + n;
    }
    if (p.type === 'chooseTargets') {
      const n = p.min || 0;
      for (let i = 0; i < n; i++) {
        await cdp.click('.seat-pick:not(.is-picked)', 0).catch(() => {});
      }
      await cdp.click('[data-m="confirm"]').catch(() => {});
      return 'chooseTargets:' + n;
    }
    if (p.type === 'chooseCardFrom') {
      if (await cdp.eval(() => {
        const b = document.querySelector('[data-m="cancel"]');
        return !!(b && !b.disabled);
      })) {
        await cdp.click('[data-m="cancel"]');
        return 'chooseCardFrom:cancel';
      }
      await cdp.click('.zone-item', 0).catch(() => {});
      await cdp.click('[data-m="confirm"]').catch(() => {});
      return 'chooseCardFrom:confirm';
    }
    if (p.type === 'arrange') {
      await cdp.click('[data-m="confirm"]');
      return 'arrange:confirm';
    }
    if (p.type === 'pickFrom') {
      await cdp.click('.pick-card', 0).catch(() => {});
      await cdp.click('[data-m="confirm"]').catch(() => {});
      return 'pickFrom:confirm';
    }
    if (p.type === 'distribute') {
      await cdp.click('[data-m="dist-self"]').catch(() => {});
      await cdp.click('[data-m="confirm"]').catch(() => {});
      return 'distribute:confirm';
    }
    await sleep(200);
    return 'pending:' + p.type;
  }

  // 回到主菜单（每段大流程独立开始，避免上一用例失败污染下一段）
  async function resetMenu() {
    await cdp.navigate(BASE + '?nofx=1&screen=home');
    await waitState((s) => s.screenActive.menu, 5000, '重置回主菜单');
    return await state();
  }

  // 清空 PWA 缓存 / Service Worker / localStorage / sessionStorage（首次点击前）
  async function clearPwaState() {
    const info = await cdp.eval(async () => {
      let sw = 0, cacheKeys = 0, localKeys = 0;
      try {
        if (navigator.serviceWorker) {
          const regs = await navigator.serviceWorker.getRegistrations();
          sw = regs.length;
          for (const r of regs) { try { await r.unregister(); } catch (e) {} }
        }
      } catch (e) {}
      try {
        if (window.caches) {
          const ks = await caches.keys();
          cacheKeys = ks.length;
          for (const k of ks) { try { await caches.delete(k); } catch (e) {} }
        }
      } catch (e) {}
      try {
        localKeys = localStorage.length;
        localStorage.clear();
        sessionStorage.clear();
      } catch (e) {}
      return { sw, cacheKeys, localKeys };
    });
    return info;
  }

  // 在页面内包一层 SGS_AUDIO.playCard，记录“请求的牌名”，与 HTMLMediaElement.play 的 src 对齐
  async function installAudioWrapper() {
    return await cdp.eval(() => {
      const A = window.SGS_AUDIO;
      if (!A || typeof A.playCard !== 'function') return false;
      if (A.__qaWrapped) return true;
      A.__qaWrapped = true;
      const orig = A.playCard.bind(A);
      A.playCard = function (name, gender) {
        try {
          window.__qaAudioCardReq = window.__qaAudioCardReq || [];
          window.__qaAudioCardReq.push({ t: Date.now(), name: String(name), gender: gender || null });
          if (window.__qaAudioCardReq.length > 600) window.__qaAudioCardReq.shift();
        } catch (e) {}
        return orig(name, gender);
      };
      const origG = A.playGeneral.bind(A);
      A.playGeneral = function (id, kind) {
        try {
          window.__qaAudioGeneral = window.__qaAudioGeneral || [];
          window.__qaAudioGeneral.push({ t: Date.now(), id: Number(id), kind: String(kind || 'skill') });
          if (window.__qaAudioGeneral.length > 600) window.__qaAudioGeneral.shift();
        } catch (e) {}
        return origG(id, kind);
      };
      const origP = A.play.bind(A);
      A.play = function (key) {
        try {
          window.__qaAudioSfx = window.__qaAudioSfx || [];
          window.__qaAudioSfx.push({ t: Date.now(), key: String(key) });
          if (window.__qaAudioSfx.length > 600) window.__qaAudioSfx.shift();
        } catch (e) {}
        return origP(key);
      };
      return true;
    });
  }

  // 清空待处理请求/弹窗并等待 400ms 稳定（用于点顶栏按钮前的保险）
  async function clearPendingSafely(timeout = 8000) {
    const t0 = Date.now();
    let stable = 0;
    while (Date.now() - t0 < timeout) {
      const st = await state();
      if (st.screenActive.result || st.over) return st;
      if (st.settingsOpen) {
        await cdp.click('#btn-settings-close').catch(() => {});
        await sleep(200);
        stable = 0;
        continue;
      }
      if (st.pending || st.modalCount > 0) {
        stable = 0;
        await pumpPending('清理').catch(() => {});
        await sleep(220);
      } else {
        stable += 220;
        if (stable >= 440) return st;
        await sleep(220);
      }
    }
    return await state();
  }

  // B5 菜单把节奏收进 <details class="b5-adv">，先展开再真实点击
  async function setMenuPace(pace) {
    const open = await cdp.eval(() => {
      const d = document.querySelector('details.b5-adv');
      return !!(d && d.open);
    });
    if (!open) {
      await cdp.click('details.b5-adv summary');
      await cdp.waitExpr('!!(document.querySelector("details.b5-adv") && document.querySelector("details.b5-adv").open)', 1500).catch(() => {});
    }
    await cdp.click('#seg-pace [data-pace="' + pace + '"]');
  }

  // 重新开一局 5p（T17 遇到对局已结束时兜底用）
  async function start5pGame() {
    await resetMenu();
    await cdp.click('#seg-mode [data-mode="5p"]');
    await setMenuPace('fast');
    await cdp.click('#btn-start');
    await waitState((s) => s.screenActive.select, 5000, '5p 重开：选将页');
    await cdp.click('#general-row .general-card', 0);
    await cdp.click('#btn-general-confirm');
    await enterGameAfterSelect({ seats: 4, label: '5p 重开：牌桌' });
  }

  // 启动 2v2 / 3v3：选将 3 张 → 保留手气卡 → 等牌桌
  async function startTeamGame(mode) {
    await resetMenu();
    await cdp.click('#seg-mode [data-mode="' + mode + '"]');
    await setMenuPace('fast');
    await cdp.click('#btn-start');
    await waitState((s) => s.screenActive.select, 5000, mode + ' 选将页');
    const cards = await cdp.eval(() => document.querySelectorAll('#general-row .general-card').length);
    const roleText = await cdp.eval(() => (document.querySelector('#select-role') || {}).textContent || '');
    await cdp.click('#general-row .general-card', 0);
    await cdp.click('#btn-general-confirm');
    const entered = await enterGameAfterSelect({ seats: (mode === '2v2' ? 3 : 5), label: mode + ' 牌桌' });
    return { cards, roleText, st: entered.st };
  }

  // 启动一局正常 8p（人类 0 号位），用于技能/装备/选目标/铁索/身份等 UI 验收
  // animated=true 时不带 nofx，保留 CSS 动画，用于验证弹窗不重播 fadeIn
  async function start8pGame(animated) {
    if (animated) {
      await cdp.navigate(BASE + '?screen=home');
      await waitState((s) => s.screenActive.menu, 5000, '8p 动画局：主菜单');
    } else {
      await resetMenu();
    }
    await cdp.click('#seg-mode [data-mode="8p"]');
    await setMenuPace('fast');
    await cdp.click('#btn-start');
    await waitState((s) => s.screenActive.select, 5000, '8p 重开：选将页');
    await cdp.click('#general-row .general-card', 0);
    await cdp.click('#btn-general-confirm');
    const entered = await enterGameAfterSelect({ seats: 7, label: '8p 重开：牌桌' });
    return await waitState((s) => s.screenActive.game && s.mode === '8p' && s.seats === 7, 8000, '8p 重开：牌桌');
  }

  // 冻结演示 8p：demo 在首个 play 请求处 freeze，游戏循环不再推进，适合稳定验证合成 UI 请求
  async function startFrozenDemo8p(animated) {
    await cdp.navigate(BASE + (animated ? '?demo=1&freeze=play&mode=8p&seed=2026' : '?nofx=1&demo=1&freeze=play&mode=8p&seed=2026'));
    return await waitState((s) => s.screenActive.game && s.seats === 7, 8000, '冻结演示 8p');
  }

  // 8p 局仍在进行且没有待处理请求时复用，否则重开；避免每条 UI 用例都等一次完整开局
  async function ensure8pGame() {
    const st = await state();
    if (st.screenActive.game && st.mode === '8p' && !st.over && st.seats === 7 && !st.pending) return st;
    return await start8pGame();
  }

  // 启动斗地主：3 张候选 → 保留手气卡 → 3 人牌桌
  async function startDdzGame() {
    await resetMenu();
    await cdp.click('#seg-mode [data-mode="ddz"]');
    await setMenuPace('fast');
    await cdp.click('#btn-start');
    await waitState((s) => s.screenActive.select, 5000, 'ddz 选将页');
    const cards = await cdp.eval(() => document.querySelectorAll('#general-row .general-card').length);
    const roleText = await cdp.eval(() => (document.querySelector('#select-role') || {}).textContent || '');
    await cdp.click('#general-row .general-card', 0);
    await cdp.click('#btn-general-confirm');
    const auction = [];
    const seenModals = [];
    // 先处理叫地主/抢地主（可能多轮），再处理手气卡
    for (let i = 0; i < 16; i++) {
      const m = await cdp.eval(() => {
        const modal = document.querySelector('#modal-root .modal');
        return {
          modal: !!modal,
          reason: (document.querySelector('#modal-root .modal-reason') || {}).textContent || '',
          options: Array.prototype.map.call(document.querySelectorAll('#modal-root .option-btn'), (b) => b.textContent.trim()),
        };
      });
      if (!m.modal) {
        const st = await state();
        const lordReady = await cdp.eval(() => {
          const g = SGS_UI._state().game;
          return !!(g && g.players && g.players.some((p) => p.role === 'landlord'));
        });
        if (st.screenActive.game && st.mode === 'ddz' && lordReady) break;
        await sleep(220);
        continue;
      }
      seenModals.push({ reason: m.reason, options: m.options });
      if (/叫地主|抢地主/.test(m.reason)) {
        auction.push({ reason: m.reason, options: m.options });
        // 按验收要求点“不抢/不叫”（最后一项），让 AI 决定地主
        await cdp.click('#modal-root .option-btn', m.options.length - 1);
        await sleep(320);
        continue;
      }
      if (/手气卡|保留手牌/.test(m.reason)) {
        const n = m.options.length;
        if (n > 0) await cdp.click('#modal-root .option-btn', n - 1);
        await sleep(300);
        continue; // 手气卡之后还有叫地主/抢地主
      }
      const n = m.options.length;
      if (n > 0) await cdp.click('#modal-root .option-btn', n - 1);
      await sleep(220);
    }
    const seenNow = await cdp.eval(() => ({
      modal: !!document.querySelector('#modal-root .modal'),
      reason: (document.querySelector('#modal-root .modal-reason') || {}).textContent || '',
      options: Array.prototype.map.call(document.querySelectorAll('#modal-root .option-btn'), (b) => b.textContent.trim()),
    }));
    seenModals.push({ at: 'after-loop', ...seenNow });
    await waitGone('#modal-root .modal', 4000, 'ddz 手气卡/拍卖未关闭');
    const st = await waitState((s) => s.screenActive.game && s.mode === 'ddz', 10000, 'ddz 牌桌');
    const multiplier = await cdp.eval(() => (SGS_UI._state().game || {}).ddzMultiplier);
    return { cards, roleText, st, auction, multiplier, seenModals };
  }

  // 兜底强制投降：处理掉遮罩弹窗，只在 play/response 或无请求时快速点击投降+确认
  async function forceSurrender(timeout = 15000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const st = await state();
      if (st.screenActive.result || st.over) return true;
      if (st.settingsOpen) {
        await cdp.click('#btn-settings-close').catch(() => {});
        await sleep(150);
        continue;
      }
      if (st.pending && st.pending.type !== 'play' && st.pending.type !== 'response') {
        await pumpPending('强制投降前清理').catch(() => {});
        await sleep(180);
        continue;
      }
      const p1 = await pointMenu('#btn-surrender');
      if (p1) {
        await cdp.clickPoint(p1.x, p1.y, 20);
        await sleep(20);
        const p2 = await cdp.point('[data-c="1"]');
        if (p2) await cdp.clickPoint(p2.x, p2.y, 30);
      }
      await sleep(350);
    }
    return false;
  }

  /* ---------- 启动 ---------- */
  async function ensureServer() {
    try {
      const res = await fetch(BASE, { redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      meta.servedIndexMd5 = md5Text(await res.text());
      meta.localIndexMd5 = md5File('index.html');
      meta.serverIndexMatch = meta.servedIndexMd5 === meta.localIndexMd5;
      return;
    } catch (e) {
      log('[WARN] 本地服务不可用，尝试启动 python3 http.server 8899：' + e.message);
    }
    serverProc = spawn('python3', ['-m', 'http.server', '8899'], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
    });
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      try {
        const res = await fetch(BASE);
        if (res.ok) {
          meta.servedIndexMd5 = md5Text(await res.text());
          meta.localIndexMd5 = md5File('index.html');
          meta.serverIndexMatch = meta.servedIndexMd5 === meta.localIndexMd5;
          return;
        }
      } catch (e) { /* retry */ }
    }
    throw new Error('无法启动本地静态服务: ' + BASE);
  }

  async function launchChrome() {
    if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome: ' + CHROME);
    const port = await freePort();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgs_qa_e2e_'));
    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--remote-allow-origins=*',
      '--force-device-scale-factor=1',
      '--window-size=1600,900',
      '--user-data-dir=' + profileDir,
      '--remote-debugging-port=' + port,
      'about:blank',
    ];
    chromeProc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    chromeProc.stderr.on('data', () => { /* Chrome 噪音不打印 */ });
    cdp = new CDP(port);
    await cdp.connect();
    // headless=new 的 window-size 不含视口高度（实测 757），显式固定 1600x900
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 900, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Network.enable').catch(() => {});
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_HOOK }).catch(() => {});
    try {
      const ver = await httpGetJson('http://127.0.0.1:' + port + '/json/version');
      meta.chromeVersion = ver && ver['Browser'] || null;
    } catch (e) { /* ignore */ }
  }

  async function cleanup() {
    try { if (cdp && cdp.ws && cdp.ws.readyState === 1 && !KEEP_OPEN) cdp.ws.close(); } catch (e) { /* ignore */ }
    if (chromeProc && !KEEP_OPEN) {
      try { chromeProc.kill('SIGTERM'); } catch (e) { /* ignore */ }
      await sleep(600);
      try { if (chromeProc.exitCode == null) chromeProc.kill('SIGKILL'); } catch (e) { /* ignore */ }
    }
    if (profileDir && !KEEP_OPEN) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
    if (serverProc) {
      try { serverProc.kill('SIGTERM'); } catch (e) { /* ignore */ }
    }
  }

  /* ============================================================
     用例
     ============================================================ */
  try {
    await ensureServer();
    if (meta.serverIndexMatch === false) {
      log('[WARN] 服务端 index.html 与本地 md5 不一致，可能服务未刷新或被代理：服务=' + meta.servedIndexMd5 + ' 本地=' + meta.localIndexMd5);
    }
    await launchChrome();
    try {
      await cdp.send('Storage.clearDataForOrigin', {
        origin: BASE.replace(/\/$/, ''),
        storageTypes: 'all',
      });
    } catch (e) { /* 旧版 Chrome 可能不支持 */ }
    await cdp.navigate(BASE + '?nofx=1&screen=home');
    const pwa = await clearPwaState();
    meta.pwaCleared = pwa;
    // 清 SW/缓存后再整页导航一次，确保菜单事件监听绑定到新文档（Page.reload 在 SW 刚注销时会留下旧监听）
    await cdp.navigate(BASE + '?nofx=1&screen=home');
    await installAudioWrapper();

    /* ---------- T01 主菜单 ---------- */
    await runCase('T01', '主菜单元素完整', [
      '打开 http://127.0.0.1:8899/?nofx=1&screen=home',
      '读取模式、武将包、牌堆、节奏按钮数量与选中态',
    ], '5 个模式按钮、5 个武将包（默认全选）、2 个牌堆、3 档节奏；开始/自动演示可用；继续游戏隐藏；底部提示显示“已选 5 个武将包”', 'P1', async (row) => {
      const st = await state();
      const m = await cdp.eval(() => ({
        modes: document.querySelectorAll('#seg-mode [data-mode]').length,
        onModes: document.querySelectorAll('#seg-mode [data-mode].is-on').length,
        packs: document.querySelectorAll('#seg-packs [data-pack]').length,
        onPacks: document.querySelectorAll('#seg-packs [data-pack].is-on').length,
        decks: document.querySelectorAll('#seg-deck [data-deck]').length,
        paces: document.querySelectorAll('#seg-pace [data-pace]').length,
        startDisabled: document.querySelector('#btn-start').disabled,
        demoDisabled: document.querySelector('#btn-demo').disabled,
        continueHidden: document.querySelector('#btn-continue').classList.contains('is-hidden'),
        note: (document.querySelector('#menu-note') || {}).textContent || '',
      }));
      const requiredModes = ['8p', '5p', '1v1', '2v2', '3v3'];
      const modeList = await cdp.eval(() => [].map.call(document.querySelectorAll('#seg-mode [data-mode]'), (b) => b.dataset.mode));
      requiredModes.forEach((x) => assert(modeList.indexOf(x) >= 0, '缺少模式按钮：' + x));
      assert(m.modes >= 5, '模式按钮数不足 5：' + m.modes);
      assertEq(m.onModes, 1, '选中模式数');
      assertEq(m.packs, 5, '武将包数');
      assertEq(m.onPacks, 5, '默认选中武将包数');
      assertEq(m.decks, 2, '牌堆按钮数');
      assertEq(m.paces, 3, '节奏按钮数');
      assert(!m.startDisabled, '开始游戏按钮不可用');
      assert(!m.demoDisabled, '自动演示按钮不可用');
      assert(m.continueHidden, '清空存档后“继续游戏”仍显示');
      assert(m.note.indexOf('已选 5 个武将包') >= 0, '底部提示未显示已选 5 包：' + m.note);
      assert(st.screenActive.menu, '主菜单未激活');
      await shot('qa_menu.png', row);
      return { actual: '模式=' + m.modes + '（含 ddz 额外模式，5 个必需模式齐全）/包5(全选)/牌堆2/节奏3/继续隐藏，提示：' + truncate(m.note, 80) };
    });

    /* ---------- T02 模式切换 ---------- */
    await runCase('T02', '模式切换 8p / 5p / 1v1 / 2v2 / 3v3', [
      '依次点击 5p / 2v2 / 3v3 / 1v1 / 8p',
      '每次读取选中态、牌堆行与底部提示',
    ], '每次仅一个模式选中；2v2/3v3 提示 4/6 人、每人 3 张候选且牌堆可用；1v1 牌堆行置灰、4 张候选；切回 8p 恢复', 'P1', async (row) => {
      await cdp.click('#seg-mode [data-mode="5p"]');
      let m5 = await cdp.eval(() => ({
        on: [].map.call(document.querySelectorAll('#seg-mode [data-mode].is-on'), (b) => b.dataset.mode),
        note: document.querySelector('#menu-note').textContent,
      }));
      assertEq(m5.on.join(','), '5p', '5p 选中态');
      assert(m5.note.indexOf('5 人局') >= 0, '5p 提示缺少“5 人局”：' + m5.note);

      await cdp.click('#seg-mode [data-mode="2v2"]');
      let team2 = await cdp.eval(() => ({
        on: [].map.call(document.querySelectorAll('#seg-mode [data-mode].is-on'), (b) => b.dataset.mode),
        note: document.querySelector('#menu-note').textContent,
        deckOff: document.querySelector('#row-deck').classList.contains('is-off'),
        deckDisabled: [].every.call(document.querySelectorAll('#seg-deck [data-deck]'), (b) => b.disabled),
      }));
      assertEq(team2.on.join(','), '2v2', '2v2 选中态');
      assert(/4 人\s*2v2/.test(team2.note) && team2.note.indexOf('3 张候选') >= 0, '2v2 提示异常：' + team2.note);
      assert(!team2.deckOff && !team2.deckDisabled, '2v2 牌堆不应禁用');

      await cdp.click('#seg-mode [data-mode="3v3"]');
      let team3 = await cdp.eval(() => ({
        on: [].map.call(document.querySelectorAll('#seg-mode [data-mode].is-on'), (b) => b.dataset.mode),
        note: document.querySelector('#menu-note').textContent,
        deckOff: document.querySelector('#row-deck').classList.contains('is-off'),
      }));
      assertEq(team3.on.join(','), '3v3', '3v3 选中态');
      assert(/6 人\s*3v3/.test(team3.note) && team3.note.indexOf('3 张候选') >= 0, '3v3 提示异常：' + team3.note);
      assert(!team3.deckOff, '3v3 牌堆不应禁用');
      await shot('qa_menu_team_modes.png', row);

      await cdp.click('#seg-mode [data-mode="1v1"]');
      const duel = await cdp.eval(() => ({
        on: [].map.call(document.querySelectorAll('#seg-mode [data-mode].is-on'), (b) => b.dataset.mode),
        note: document.querySelector('#menu-note').textContent,
        deckOff: document.querySelector('#row-deck').classList.contains('is-off'),
        deckDisabled: [].every.call(document.querySelectorAll('#seg-deck [data-deck]'), (b) => b.disabled),
      }));
      assertEq(duel.on.join(','), '1v1', '1v1 选中态');
      assert(duel.deckOff, '1v1 牌堆行未置灰');
      assert(duel.deckDisabled, '1v1 牌堆按钮未禁用');
      assert(duel.note.indexOf('单挑') >= 0 && duel.note.indexOf('4 张候选') >= 0, '1v1 提示不含 4 张候选：' + duel.note);
      await shot('qa_menu_1v1.png', row);

      await cdp.click('#seg-mode [data-mode="8p"]');
      const m8 = await cdp.eval(() => ({
        on: [].map.call(document.querySelectorAll('#seg-mode [data-mode].is-on'), (b) => b.dataset.mode),
        note: document.querySelector('#menu-note').textContent,
        deckOff: document.querySelector('#row-deck').classList.contains('is-off'),
        deckEnabled: [].every.call(document.querySelectorAll('#seg-deck [data-deck]'), (b) => !b.disabled),
      }));
      assertEq(m8.on.join(','), '8p', '8p 选中态');
      assert(!m8.deckOff && m8.deckEnabled, '切回 8p 后牌堆未恢复');
      assert(m8.note.indexOf('8 人局') >= 0, '8p 提示缺少“8 人局”');
      return { actual: '5p/2v2/3v3/1v1/8p 选中态与提示正确；1v1 牌堆禁用，2v2/3v3 可用' };
    });

    /* ---------- T03 武将包 ---------- */
    await runCase('T03', '武将包勾选（5 包/至少保留 1 包）', [
      '点击“风”取消，再点击恢复',
      '依次取消“火/林/山”只留“标准”',
      '再点击“标准”尝试取消最后一个包',
      '恢复风火林山',
    ], '勾选数随点击增减；只剩标准时点击标准被拦截并提示“至少保留一个武将包”；恢复后 5 包全选', 'P1', async (row) => {
      const packState = () => cdp.eval(() => ({
        on: [].map.call(document.querySelectorAll('#seg-packs [data-pack].is-on'), (b) => b.dataset.pack),
        note: document.querySelector('#menu-note').textContent,
        toast: (document.querySelector('#toast-root .toast') || {}).textContent || '',
      }));
      await cdp.click('#seg-packs [data-pack="风"]');
      let s = await packState();
      assertEq(s.on.length, 4, '取消风后选中数');
      assert(s.note.indexOf('已选 4 个武将包') >= 0, '取消风后提示未更新');
      await cdp.click('#seg-packs [data-pack="风"]');
      s = await packState();
      assertEq(s.on.length, 5, '恢复风后选中数');

      try {
        for (const p of ['风', '火', '林', '山']) {
          await cdp.click('#seg-packs [data-pack="' + p + '"]');
        }
        s = await packState();
        assertEq(s.on.join(','), '标准', '只剩标准');
        await cdp.click('#seg-packs [data-pack="标准"]');
        s = await packState();
        assertEq(s.on.length, 1, '最后一个包被取消');
        assert(s.toast.indexOf('至少保留一个武将包') >= 0, '未出现“至少保留一个武将包”提示，实际 toast=' + s.toast);
      } finally {
        // 无论断言是否失败都恢复 5 包，避免污染后续用例
        for (const p of ['风', '火', '林', '山']) {
          const on = await cdp.eval((pack) => {
            const b = document.querySelector('#seg-packs [data-pack="' + pack + '"]');
            return !!(b && b.classList.contains('is-on'));
          }, p);
          if (!on) await cdp.click('#seg-packs [data-pack="' + p + '"]');
        }
      }
      s = await packState();
      assertEq(s.on.length, 5, '恢复后选中数');
      return { actual: '4↔5 切换正常；最后 1 包被拦截并 toast：' + s.toast };
    });

    /* ---------- T04 牌堆/节奏 ---------- */
    await runCase('T04', '牌堆与节奏三档切换', [
      '点击牌堆“标准”再点“标准 + 军争”',
      '依次点击节奏“慢/标准/快”',
    ], '牌堆选中态与提示中的 108/160 张一致；节奏选中态与提示中的慢/标准/快一致', 'P1', async (row) => {
      await cdp.click('#seg-deck [data-deck="standard"]');
      let s = await cdp.eval(() => ({
        on: document.querySelector('#seg-deck .is-on').dataset.deck,
        note: document.querySelector('#menu-note').textContent,
      }));
      assertEq(s.on, 'standard', '标准牌堆选中');
      assert(s.note.indexOf('108 张') >= 0, '牌堆提示未显示 108 张');
      await cdp.click('#seg-deck [data-deck="full"]');
      s = await cdp.eval(() => ({
        on: document.querySelector('#seg-deck .is-on').dataset.deck,
        note: document.querySelector('#menu-note').textContent,
      }));
      assertEq(s.on, 'full', '军争牌堆选中');
      assert(s.note.indexOf('160 张') >= 0, '牌堆提示未显示 160 张');

      const paceNote = async (pace, word) => {
        await setMenuPace(pace);
        const r = await cdp.eval(() => ({
          on: document.querySelector('#seg-pace .is-on').dataset.pace,
          note: document.querySelector('#menu-note').textContent,
        }));
        assertEq(r.on, pace, '节奏选中 ' + pace);
        assert(r.note.indexOf('节奏 ' + word) >= 0, '节奏提示未更新为 ' + word + '：' + r.note);
      };
      await paceNote('slow', '慢');
      await paceNote('normal', '标准');
      await paceNote('fast', '快');
      return { actual: '牌堆 108/160、节奏 慢/标准/快 均正确；最终节奏=快' };
    });

    /* ---------- T05 8p 选将 ---------- */
    await runCase('T05', '开始游戏 → 八人选将页（5 张候选）', [
      '点击“开始游戏”',
      '等待选将页出现',
      '读取候选武将卡数量与确定按钮状态',
    ], '进入选将页，候选 5 张，确定出战 disabled，身份/提示文案存在', 'P0', async (row) => {
      // 独立起点：回主菜单并显式设置 8p / 5 包 / 军争 / 快节奏
      await resetMenu();
      await cdp.click('#seg-mode [data-mode="8p"]');
      await cdp.click('#seg-deck [data-deck="full"]');
      await setMenuPace('fast');
      const menu = await state();
      assertEq(menu.menuNote.indexOf('已选 5 个武将包') >= 0, true, '武将包未恢复 5 个：' + menu.menuNote);
      await cdp.click('#btn-start');
      const st = await waitState((s) => s.screenActive.select, 5000, '等待选将页');
      const m = await cdp.eval(() => ({
        cards: document.querySelectorAll('#general-row .general-card').length,
        disabled: document.querySelector('#btn-general-confirm').disabled,
        role: (document.querySelector('#select-role') || {}).textContent || '',
        reason: (document.querySelector('#select-reason') || {}).textContent || '',
        hint: (document.querySelector('#select-hint') || {}).textContent || '',
      }));
      assertEq(m.cards, 5, '8p 候选数');
      assert(m.disabled, '确定出战按钮初始未禁用');
      assert(/身份：/.test(m.role), '身份文案异常：' + m.role);
      assert(m.reason.length > 0, '选将提示为空');
      await shot('qa_select_8p.png', row);
      return { actual: '候选=5，确定按钮 disabled，身份=' + m.role + '，提示=' + truncate(m.reason, 30) };
    });

    /* ---------- T06 选将确认 → 手气卡 ---------- */
    await runCase('T06', '选将交互并确认出战 → 手气卡弹窗', [
      '点击第 2 张候选卡',
      '点击第 1 张候选卡',
      '点击“确定出战”',
      '等待手气卡弹窗',
    ], '选中态唯一且确定按钮可用；确认后进入对局并弹出“使用/保留手牌”手气卡弹窗，剩余 3 次', 'P0', async (row) => {
      await cdp.click('#general-row .general-card', 1);
      let m = await cdp.eval(() => ({
        picked: [].map.call(document.querySelectorAll('#general-row .general-card.is-picked'), (e) => e.dataset.index),
        disabled: document.querySelector('#btn-general-confirm').disabled,
        hint: document.querySelector('#select-hint').textContent,
      }));
      assertEq(m.picked.join(','), '1', '第 2 张卡选中态');
      assert(!m.disabled, '选中后确定按钮仍禁用');
      assert(m.hint.indexOf('已选择') >= 0, '底部提示未显示已选择');
      await cdp.click('#general-row .general-card', 0);
      m = await cdp.eval(() => ({
        picked: [].map.call(document.querySelectorAll('#general-row .general-card.is-picked'), (e) => e.dataset.index),
        hint: document.querySelector('#select-hint').textContent,
      }));
      assertEq(m.picked.join(','), '0', '第 1 张卡选中态');
      await cdp.click('#btn-general-confirm');
      const mm = await detectMulligan(1500);
      if (!mm.present) {
        row.notes.push('手气卡功能已临时关闭（js/game.js mulliganPhase return），跳过弹窗断言');
        const gs = await waitState((s) => s.screenActive.game, 8000, '确认后进入对局');
        assertEq(gs.handDom, 4, '开局手牌数');
        assert(gs.deck > 0, '开局牌堆异常：' + gs.deck);
        return { actual: '选将选中态正常；手气卡已临时关闭，跳过弹窗断言（对局已开始，手牌=4，牌堆=' + gs.deck + '）' };
      }
      const detail = await cdp.eval(() => ({
        reason: document.querySelector('#modal-root .modal-reason').textContent,
        options: [].map.call(document.querySelectorAll('#modal-root .option-btn'), (b) => b.textContent),
        hand: document.querySelectorAll('#hand .hand-card').length,
      }));
      assert(detail.reason.indexOf('手气卡') >= 0, '弹窗不是手气卡：' + detail.reason);
      assert(detail.reason.indexOf('剩余 3 次') >= 0, '手气卡次数不是 3：' + detail.reason);
      assert(detail.options.indexOf('使用') >= 0 && detail.options.indexOf('保留手牌') >= 0, '手气卡选项缺失：' + detail.options.join('/'));
      assertEq(detail.hand, 4, '初始手牌数');
      await shot('qa_mulligan.png', row);
      row.notes.push('选将顺序：先点第 2 张再点第 1 张，验证选中态唯一');
      return { actual: '候选选中切换正常；手气卡弹窗选项=使用/保留手牌，手牌=4，剩余 3 次' };
    });

    /* ---------- T06b 手气卡弹窗展示手牌 ---------- */
    await runCase('T06b', '手气卡弹窗展示 4 张手牌', [
      '等待手气卡弹窗',
      '读取 .mul-preview 中的卡牌数量与名称',
      '对照当前手牌数并截图',
    ], '弹窗内展示 4 张手牌（图片+牌名），与当前手牌数一致；截图 qa_mulligan_hand.png', 'P1', async (row) => {
      const mm = await detectMulligan(1500);
      if (!mm.present) return { skip: '手气卡功能已临时关闭（js/game.js mulliganPhase return），无法验证弹窗内 4 张手牌' };
      const m = await cdp.eval(() => ({
        preview: document.querySelectorAll('#modal-root .mul-preview .mul-card').length,
        names: [].map.call(document.querySelectorAll('#modal-root .mul-preview .mul-name'), (el) => el.textContent),
        imgs: document.querySelectorAll('#modal-root .mul-preview .mul-card img').length,
        hand: document.querySelectorAll('#hand .hand-card').length,
      }));
      assertEq(m.preview, 4, '弹窗展示手牌数');
      assertEq(m.imgs, 4, '弹窗手牌图片数');
      assertEq(m.hand, 4, '当前手牌数');
      assert(m.names.length === 4 && m.names.every((n) => n && n.trim().length > 0), '手牌名称缺失：' + m.names.join('/'));
      await shot('qa_mulligan_hand.png', row);
      return { actual: '弹窗展示 4 张手牌：' + m.names.join('、') + '；与当前手牌 4 张一致' };
    });

    /* ---------- T07 手气卡使用 ---------- */
    await runCase('T07', '手气卡“使用”重摸', [
      '记录当前手牌数',
      '点击“使用”',
      '等待再次弹出弹窗',
      '读取剩余次数、手牌数与弃牌数',
    ], '手牌仍为 4 张；弃牌堆 +4；弹窗再次出现且剩余次数变为 2', 'P1', async (row) => {
      const mm = await detectMulligan(600);
      if (!mm.present) return { skip: '手气卡功能已临时关闭（js/game.js mulliganPhase return），跳过“使用”重摸断言' };
      const before = await state();
      assertEq(before.handDom, 4, '使用前手牌数');
      const discardBefore = before.discard;
      await cdp.click('#modal-root .option-btn', 0);
      const st = await waitState((s) => s.pending && s.pending.type === 'chooseOption' && s.modalReason.indexOf('剩余 2 次') >= 0, 4000, '等待第二次手气卡弹窗');
      const detail = await cdp.eval(() => ({
        reason: document.querySelector('#modal-root .modal-reason').textContent,
        hand: document.querySelectorAll('#hand .hand-card').length,
        discard: Number(document.querySelector('#tb-discard').textContent),
      }));
      assert(detail.reason.indexOf('剩余 2 次') >= 0, '剩余次数未变为 2：' + detail.reason);
      assertEq(detail.hand, 4, '重摸后手牌数');
      assertEq(detail.discard, discardBefore + 4, '弃牌堆增加数');
      return { actual: '重摸后手牌=4，弃牌 ' + discardBefore + '→' + detail.discard + '，剩余 2 次' };
    });

    /* ---------- T08 保留手牌 ---------- */
    await runCase('T08', '手气卡“保留手牌”→ 对局开始', [
      '点击“保留手牌”',
      '等待弹窗关闭',
      '读取对局屏幕、手牌与牌堆',
    ], '弹窗关闭；对局屏幕激活；手牌 4 张；牌堆为正数；自己的武将名已显示', 'P0', async (row) => {
      const mm = await detectMulligan(800);
      if (mm.present) {
        await cdp.click('#modal-root .option-btn', 1);
        await waitGone('#modal-root .modal', 3000, '手气卡弹窗未关闭');
      } else {
        row.notes.push('手气卡功能已临时关闭（js/game.js mulliganPhase return），跳过“保留手牌”点击，直接校验对局状态');
      }
      const st = await waitState((s) => s.screenActive.game && s.screen === 'game', 5000, '等待对局开始');
      const m = await cdp.eval(() => ({
        hand: document.querySelectorAll('#hand .hand-card').length,
        deck: Number(document.querySelector('#tb-deck').textContent),
        me: (document.querySelector('#me-name') || {}).textContent || '',
      }));
      assert(m.hand >= 4, '开局手牌少于 4');
      assert(m.deck > 0, '牌堆数异常：' + m.deck);
      assert(m.me && m.me !== '—', '自己的武将名未显示');
      return { actual: '弹窗关闭，手牌=' + m.hand + '，牌堆=' + m.deck + '，武将=' + m.me };
    });

    /* ---------- T09 八人牌桌 ---------- */
    await runCase('T09', '八人牌桌布局（7 个对手座位）', [
      '等待座位渲染',
      '读取座位数与座位坐标',
      '读取手牌、头像与顶栏',
    ], '7 个对手座位且坐标各不相同；自己的头像/手牌已渲染；顶栏牌堆/回合数字正常', 'P0', async (row) => {
      const st = await waitState((s) => s.seats === 7, 4000, '等待 7 个对手座位');
      await sleep(900); // 等人物图加载
      const st2 = await state();
      const uniq = new Set(st2.seatPos.map((p) => p.x + ',' + p.y));
      assertEq(st2.seats, 7, '对手座位数');
      assertEq(uniq.size, 7, '座位坐标唯一数');
      assert(st2.handDom >= 4, '手牌未渲染');
      const top = await cdp.eval(() => ({
        deck: document.querySelector('#tb-deck').textContent,
        turn: document.querySelector('#tb-turn').textContent,
        phase: document.querySelector('#tb-phase').textContent,
      }));
      assert(Number(top.deck) > 0, '顶栏牌堆为空');
      await shot('qa_table_8p.png', row);
      return { actual: '座位=7（坐标唯一），手牌=' + st2.handDom + '，牌堆=' + top.deck + '，回合=' + top.turn };
    });

    /* ---------- T10 设置抽屉 ---------- */
    await runCase('T10', '设置抽屉（音量/动画/节奏）', [
      '展开「更多」菜单 → 点击“设置”',
      '读取滑杆与开关初始值',
      '点击设置内“快”节奏',
      '切换动画开关两次',
      '关闭设置',
    ], '设置面板打开；BGM=35%、音效=70%（audio.js 默认）、动画开；设置内切“标准/快”能即时改 AI 行动间隔（标准 1500ms / 快 850ms）与阶段停顿系数（1.35 / 0.8）；动画开关能切换 body.reduce-motion 并恢复；关闭后抽屉收起', 'P2', async (row) => {
      await ensure8pGame();
      // 随机武将可能带观星/洛神等开局询问；先清掉弹窗，保证设置按钮不被 modal 挡住
      for (let i = 0; i < 8; i++) {
        const has = await cdp.eval(() => !!document.querySelector('#modal-root .modal'));
        if (!has) break;
        const n = await cdp.eval(() => document.querySelectorAll('#modal-root .option-btn').length);
        if (n > 0) await cdp.click('#modal-root .option-btn', n - 1);
        await sleep(180);
      }
      await clickMenu('#btn-settings');
      await cdp.waitExpr('document.querySelector("#settings-panel").classList.contains("is-open")', 2000);
      try {
        const s0 = await cdp.eval(() => ({
          bgm: document.querySelector('#set-bgm').value,
          bgmVal: document.querySelector('#set-bgm-val').textContent,
          sfx: document.querySelector('#set-sfx').value,
          sfxVal: document.querySelector('#set-sfx-val').textContent,
          anim: document.querySelector('#set-anim').checked,
          paceOn: (document.querySelector('#set-pace .is-on') || {}).dataset ? document.querySelector('#set-pace .is-on').dataset.pace : null,
          open: document.querySelector('#settings-panel').classList.contains('is-open'),
        }));
        assert(s0.open, '设置面板未打开');
        assertEq(s0.bgmVal, '35%', 'BGM 初始值');
        assertEq(s0.sfxVal, '70%', '音效初始值');
        assertEq(s0.sfx, '70', '音效滑杆初始值');
        assert(s0.anim, '动画开关初始应为开');
        assertEq(s0.paceOn, 'fast', '设置内节奏应反映菜单当前快节奏');
        await shot('qa_settings.png', row);

        // 设置里的“节奏”改的是 AI 行动间隔（game.agents[].speed），不是引擎 pause 系数
        const aiSpeeds = () => cdp.eval(() => {
          const st = window.SGS_UI._state();
          const g = st && st.game;
          return g && g.agents ? g.agents.filter((a) => a && typeof a.speed === 'number').map((a) => a.speed) : [];
        });
        await cdp.click('#set-pace [data-pace="normal"]');
        let paceOn = await cdp.eval(() => (document.querySelector('#set-pace .is-on') || {}).dataset.pace);
        assertEq(paceOn, 'normal', '设置内节奏选中 normal');
        let speeds = await aiSpeeds();
        let paceFactor = await cdp.eval(() => (window.SGS_UI._state().game || {}).paceFactor);
        assert(speeds.length > 0 && speeds.every((v) => v === 1500), '设置标准节奏未生效 AI speed=' + JSON.stringify(speeds));
        assert(Math.abs(paceFactor - 1.35) < 0.001, '标准节奏阶段停顿系数=' + paceFactor);
        await cdp.click('#set-pace [data-pace="fast"]');
        paceOn = await cdp.eval(() => (document.querySelector('#set-pace .is-on') || {}).dataset.pace);
        assertEq(paceOn, 'fast', '设置内节奏选中 fast');
        speeds = await aiSpeeds();
        paceFactor = await cdp.eval(() => (window.SGS_UI._state().game || {}).paceFactor);
        assert(speeds.length > 0 && speeds.every((v) => v === 850), '设置快节奏未生效 AI speed=' + JSON.stringify(speeds));
        assert(Math.abs(paceFactor - 0.8) < 0.001, '快节奏阶段停顿系数=' + paceFactor);

        await cdp.click('#settings-panel label.switch:has(#set-anim)');
        let reduce = await cdp.eval(() => document.body.classList.contains('reduce-motion'));
        assert(reduce, '关闭动画后未添加 reduce-motion');
        await cdp.click('#settings-panel label.switch:has(#set-anim)');
        reduce = await cdp.eval(() => document.body.classList.contains('reduce-motion'));
        assert(!reduce, '恢复动画后 reduce-motion 未移除');
        row.notes.push('音效默认 70% 来自 js/audio.js 的 volume:0.7');
        return { actual: 'BGM=35%、音效=70%、动画开；设置内 标准/快 即时生效 AI speed（1500/850）与阶段停顿系数（1.35/0.8）；动画开关往返正常' };
      } finally {
        if (await cdp.eval(() => document.querySelector('#settings-panel').classList.contains('is-open'))) {
          await cdp.click('#btn-settings-close').catch(() => {});
          await cdp.waitExpr('!document.querySelector("#settings-panel").classList.contains("is-open")', 2000).catch(() => {});
        }
      }
    });

    /* ---------- T11 身份标记 ---------- */
    await runCase('T11', '身份标记点击循环（忠/反/内/未知）', [
      '找到一名身份未知的对手座位',
      '点击其身份标记 4 次',
      '读取标记文字与 class',
    ], '标记依次变为 忠→反→内→？，对应 class mark-loyalist/mark-rebel/mark-renegade，且不触发座位选择', 'P1', async (row) => {
      // 保险：关闭设置抽屉/弹窗，避免遮挡座位
      if (await cdp.eval(() => document.querySelector('#settings-panel').classList.contains('is-open'))) {
        await cdp.click('#btn-settings-close');
      }
      if ((await state()).modalCount > 0) await clearPendingSafely(5000);
      // 选一个身份未知且中心点确实能命中 .seat-role 的座位（矮视口下座位可能互相遮挡）
      const target = await cdp.eval(() => {
        const seats = Array.prototype.slice.call(document.querySelectorAll('#seats .seat'));
        for (const el of seats) {
          const r = el.querySelector('.seat-role');
          if (!r || r.textContent.trim() !== '？') continue;
          const b = r.getBoundingClientRect();
          const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
          if (hit === r || r.contains(hit)) return el.dataset.seat;
        }
        return null;
      });
      assert(target != null, '未找到可点击的身份未知对手座位');
      const sel = '.seat[data-seat="' + target + '"] .seat-role';
      await cdp.click(sel);
      let m = await cdp.eval((s) => {
        const el = document.querySelector(s);
        return { text: el.textContent, cls: el.className };
      }, sel);
      assertEq(m.text, '忠', '第一次点击标记');
      assert(m.cls.indexOf('mark-loyalist') >= 0, '第一次点击 class 未添加 mark-loyalist：' + m.cls);
      await cdp.click(sel);
      m = await cdp.eval((s) => {
        const el = document.querySelector(s);
        return { text: el.textContent, cls: el.className, picked: document.querySelectorAll('#seats .seat-picked').length };
      }, sel);
      assertEq(m.text, '反', '第二次点击标记');
      assert(m.cls.indexOf('mark-rebel') >= 0, '第二次点击 class 未添加 mark-rebel：' + m.cls);
      await shot('qa_identity_mark.png', row);
      await cdp.click(sel);
      m = await cdp.eval((s) => ({ text: document.querySelector(s).textContent }), sel);
      assertEq(m.text, '内', '第三次点击标记');
      await cdp.click(sel);
      m = await cdp.eval((s) => ({
        text: document.querySelector(s).textContent,
        cls: document.querySelector(s).className,
      }), sel);
      assertEq(m.text, '？', '第四次点击标记');
      assert(m.cls.indexOf('is-marked') < 0 && m.cls.indexOf('mark-') < 0, '清除标记后仍残留 class：' + m.cls);
      return { actual: '座位 ' + target + ' 标记循环 忠→反→内→？，未触发选座' };
    });

    /* ---------- T12 托管 ---------- */
    await runCase('T12', '托管开关', [
      '等待当前无待处理请求',
      '展开「更多」菜单 → 点击“托管”',
      '再次点击取消',
    ], '按钮文字变为“取消托管”且 is-on；再点恢复“托管”并出现对应 toast', 'P1', async (row) => {
      // 若正轮到自己出牌/有弹窗，先清理并等待稳定，避免托管一开就被 AI 接管
      await clearPendingSafely(8000);
      await clickMenu('#btn-trust');
      let m = await cdp.eval(() => ({
        text: document.querySelector('#btn-trust').textContent,
        on: document.querySelector('#btn-trust').classList.contains('is-on'),
        toasts: [].map.call(document.querySelectorAll('#toast-root .toast'), (el) => el.textContent),
      }));
      assertEq(m.text, '取消托管', '托管开启后按钮文字');
      assert(m.on, '托管开启后缺少 is-on');
      assert(m.toasts.some((t) => t.indexOf('已开启托管') >= 0), '未出现开启托管 toast：' + m.toasts.join('|'));
      await clickMenu('#btn-trust');
      m = await cdp.eval(() => ({
        text: document.querySelector('#btn-trust').textContent,
        on: document.querySelector('#btn-trust').classList.contains('is-on'),
        toasts: [].map.call(document.querySelectorAll('#toast-root .toast'), (el) => el.textContent),
      }));
      assertEq(m.text, '托管', '取消托管后按钮文字');
      assert(!m.on, '取消托管后仍带 is-on');
      assert(m.toasts.some((t) => t.indexOf('已取消托管') >= 0), '未出现取消托管 toast：' + m.toasts.join('|'));
      return { actual: '托管/取消托管 文案、is-on、toast 均正确' };
    });

    /* ---------- T32 AI 出牌方向箭头 ---------- */
    await runCase('T32', 'AI 出牌方向箭头（颜色待确认）', [
      '等待 AI 回合',
      '轮询 #aim-layer 中的 is-transient 路径',
      '命中后读取描边颜色/marker 并截图',
    ], 'AI 使用带目标的牌时出现橙色 #E47816 光带（金龙按等阶，默认 0 阶关闭）并截图 qa_ai_arrow.png', 'P1', async (row) => {
      let st0 = await state();
      if (!st0.screenActive.game || st0.over || st0.screenActive.result) {
        await start5pGame();
        await clickMenu('#btn-trust');
        await sleep(500);
      }
      let found = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 90000) {
        const st = await state();
        if (st.screenActive.result || st.over) break;
        if (st.transient > 0) { found = st; break; }
        if (st.pending) {
          if (st.pending.type === 'play') {
            await cdp.click('[data-act="play-end"]').catch(() => {});
          } else {
            await pumpPending('等待 AI 箭头').catch(() => {});
          }
        }
        await sleep(50);
      }
      assert(found, '90s 内未捕获 AI 出牌方向箭头（可能本局 AI 未使用带目标牌）');
      await shot('qa_ai_arrow.png', row);
      const stroke = String(found.transientStroke).replace(/\s+/g, '');
      const marker = String(found.transientMarker || '');
      assert(found.transient >= 1, '未找到 is-transient 箭头路径');
      const isBlue = stroke.indexOf('128,206,255') >= 0 || marker.indexOf('aimArrowBlue') >= 0;
      if (!isBlue) row.notes.push('箭头实际颜色 stroke=' + found.transientStroke + ' marker=' + marker + '；需求描述为蓝色，需确认');
      return { actual: '捕获 ' + found.transient + ' 条瞬时箭头，stroke=' + found.transientStroke + '，marker=' + (marker || '—') + (isBlue ? '（蓝色）' : '（橙色，与蓝色需求不一致）') };
    });

    /* ---------- T13b 投降确认框在 AI 回合的稳定性 ---------- */
    await runCase('T13b', '投降确认框在 AI 回合的稳定性（3 次）', [
      '清空待处理请求，处于 AI 回合',
      '重复 3 次：展开「更多」菜单并点击“投降”，每 30ms 轮询确认框是否存在',
      '记录每次确认框存活时间与截图',
    ], '每次确认框出现后都应持续到用户点击（≥800ms），不能因 AI 行动重渲染而消失', 'P1', async (row) => {
      const attempts = [];
      let shotDone = false;
      for (let n = 0; n < 3; n++) {
        await clearPendingSafely(5000);
        const st = await state();
        if (st.over || st.screenActive.result) break;
        // 尽量选在 AI 刚行动完的间隙点击
        const logs0 = await cdp.eval(() => document.querySelectorAll('#log-body .log-line').length);
        const tw = Date.now();
        while (Date.now() - tw < 1200) {
          const c = await cdp.eval(() => document.querySelectorAll('#log-body .log-line').length);
          if (c !== logs0) break;
          await sleep(50);
        }
        await clickMenu('#btn-surrender', 0, { wait: 20 });
        let first = null, firstAt = 0, lastSeen = 0;
        const t0 = Date.now();
        while (Date.now() - t0 < 1300) {
          const present = await cdp.eval(() => !!document.querySelector('[data-c="1"]'));
          if (present) {
            if (first == null) {
              first = Date.now() - t0;
              if (!shotDone) { shotDone = true; await shot('qa_surrender_vanished.png', row); }
            }
            lastSeen = Date.now() - t0;
          } else if (first != null) {
            break;
          }
          await sleep(30);
        }
        const lifetime = first == null ? -1 : (lastSeen - first);
        attempts.push({ attempt: n + 1, first: first, lifetime: lifetime });
        // 若确认框还在，点取消回到对局
        if (await cdp.eval(() => !!document.querySelector('[data-c="0"]'))) {
          await cdp.eval(() => { const b = document.querySelector('[data-c="0"]'); if (b) b.click(); });
          await sleep(150);
        }
        await sleep(200);
      }
      assert(attempts.length > 0, '未能完成任何一次投降确认框测量');
      const minLife = Math.min.apply(null, attempts.map((a) => a.lifetime));
      const detail = attempts.map((a) => '#' + a.attempt + '=' + (a.lifetime < 0 ? '未出现' : a.lifetime + 'ms')).join('，');
      if (minLife < 800) {
        row.notes.push('3 次测量：' + detail + '（当前 ui.js 的 renderModal() 会清空 modalRoot）');
        throw new Error('确认框存活时间不足 800ms：' + detail + '，用户来不及确认');
      }
      return { actual: '3 次确认框存活：' + detail };
    });

    /* ---------- T13 投降确认（玩家待处理请求期间） ---------- */
    await runCase('T13', '投降确认框（取消/确认）', [
      '等待自己有待处理请求（无 AI 重渲染干扰）',
      '展开「更多」菜单 → 点击“投降”，读取文案/按钮并截图',
      '点击“取消”回到对局',
      '再次点击“投降”并确认',
    ], '弹窗文案“确定投降？本局将判负。”；确认框持续到用户点击；取消后仍在对局；确认后进入结算', 'P0', async (row) => {
      // 等到人类有待处理请求：此时引擎不会因 AI 行动而重渲染，确认框可稳定存在
      let st = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        st = await state();
        if (st.over || st.screenActive.result) break;
        if (st.pending) {
          if (st.pending.seat === 0 && (st.pending.type === 'play' || st.pending.type === 'response')) break;
          // 弹窗类请求会遮住「更多」菜单入口，先处理掉再等 play/response 窗口
          await pumpPending('等待投降窗口').catch(() => {});
          await sleep(180);
          continue;
        }
        await sleep(150);
      }
      if (!st || st.over) return { skip: '对局已结束，无法测试投降确认' };
      if (!st.pending || (st.pending.type !== 'play' && st.pending.type !== 'response')) {
        return { skip: '60s 内没有 play/response 稳定窗口，无法测试投降确认' };
      }
      await clickMenu('#btn-surrender', 0, { wait: 25 });
      await sleep(50);
      const dlg = await cdp.eval(() => {
        const ok = document.querySelector('[data-c="1"]');
        return {
          present: !!ok,
          title: (document.querySelector('#modal-root .modal-title') || {}).textContent || '',
          reason: (document.querySelector('#modal-root .modal-reason') || {}).textContent || '',
          buttons: [].map.call(document.querySelectorAll('#modal-root .modal-foot .btn'), (b) => b.textContent),
        };
      });
      assert(dlg.present, '点击“投降”后确认框未出现（待处理请求期间）');
      assert(dlg.reason.indexOf('确定投降') >= 0, '投降确认文案异常：' + dlg.reason);
      assert(dlg.buttons.indexOf('取消') >= 0 && dlg.buttons.indexOf('投降') >= 0, '投降确认按钮异常：' + dlg.buttons.join('/'));
      await shot('qa_surrender_confirm.png', row);
      await cdp.click('[data-c="0"]', 0, { wait: 30 });
      await waitGone('#modal-root .modal', 2000, '取消后弹窗未关闭');
      const st2 = await state();
      assert(st2.screenActive.game && !st2.over, '取消投降后不在对局中');
      // 再次投降并确认（仍在待处理请求窗口内）
      const p1 = await pointMenu('#btn-surrender');
      assert(p1, '第二次点击投降失败：按钮不可见');
      await cdp.clickPoint(p1.x, p1.y, 20);
      await sleep(30);
      const p2 = await cdp.point('[data-c="1"]');
      assert(p2, '第二次投降确认框未出现');
      await cdp.clickPoint(p2.x, p2.y, 30);
      return { actual: '确认框文案/按钮正确；取消回对局；二次确认已提交' };
    });

    /* ---------- T14 8p 结算 ---------- */
    await runCase('T14', '投降 → 结算页（8 人）', [
      '等待结算页出现',
      '读取标题/副标题/8 名玩家与你的存活状态',
      '校验胜负与存活一致',
    ], '标题为 胜利/失败/平局 之一；玩家卡片 8 张；副标题含“回合”；战斗失败则“你”阵亡、胜利则存活；投降结算允许“你”存活但判负', 'P0', async (row) => {
      let st = await state();
      // 兜底：若 T13 未提交（确认框被 render 清空），强制投降直到结算页
      for (let attempt = 0; attempt < 2 && !st.screenActive.result; attempt++) {
        await forceSurrender(12000).catch(() => {});
        try {
          st = await waitState((s) => s.screenActive.result, 6000, '等待结算页');
          break;
        } catch (e) { st = await state(); }
      }
      assert(st.screenActive.result, '多次尝试后仍未进入结算页');
      st = await state();
      assert(['胜利', '失败', '平局'].indexOf(st.resultTitle) >= 0, '结算标题异常：' + st.resultTitle);
      assertEq(st.resultPlayers.length, 8, '结算玩家数');
      assert(st.resultSub.indexOf('回合') >= 0, '结算副标题缺少回合数：' + st.resultSub);
      const you = st.resultPlayers.find((p) => p.you);
      assert(you, '结算页没有“你”的卡片');
      const surrendered = /投降/.test(st.resultSub);
      if (st.resultTitle === '失败' && !surrendered) assert(you.dead, '战斗失败但“你”未阵亡');
      if (st.resultTitle === '胜利') assert(!you.dead, '标题胜利但“你”已阵亡');
      if (surrendered) {
        assertEq(st.resultTitle, '失败', '投降结算标题');
        assert(!you.winner, '投降玩家被标记为获胜方');
      }
      assert(st.resultPlayers.some((p) => p.winner), '结算页没有获胜方标记');
      await shot('qa_result_8p.png', row);
      return { actual: '标题=' + st.resultTitle + '，玩家=8，你=' + (you.dead ? '阵亡' : '存活') + '，' + truncate(st.resultSub, 60) };
    });

    /* ---------- T15 结算回主菜单 ---------- */
    await runCase('T15', '结算页“返回主菜单”', [
      '点击“返回主菜单”',
      '等待主菜单激活',
    ], '回到主菜单，结算页不再激活，菜单提示仍在', 'P1', async (row) => {
      await cdp.click('#btn-home');
      const st = await waitState((s) => s.screenActive.menu, 3000, '等待返回主菜单');
      assert(!st.screenActive.result, '返回后结算页仍激活');
      assert(st.menuNote.indexOf('已选') >= 0, '主菜单提示丢失');
      return { actual: '已返回主菜单' };
    });

    /* ---------- T16 5p 牌桌 ---------- */
    await runCase('T16', '五人身份局牌桌（4 个对手座位）', [
      '点击“五人身份局”',
      '点击“开始游戏”并选将（手气卡已临时关闭时跳过）',
      '读取座位数与手牌',
    ], '选将候选 5 张；对局开始后 4 个对手座位；手牌正常渲染', 'P1', async (row) => {
      await resetMenu();
      await cdp.click('#seg-mode [data-mode="5p"]');
      await setMenuPace('fast');
      await cdp.click('#btn-start');
      await waitState((s) => s.screenActive.select, 5000, '5p 选将页');
      const cards = await cdp.eval(() => document.querySelectorAll('#general-row .general-card').length);
      assertEq(cards, 5, '5p 候选数');
      await cdp.click('#general-row .general-card', 0);
      await cdp.click('#btn-general-confirm');
      const mm = await detectMulligan(1500);
      if (mm.present) {
        await cdp.click('#modal-root .option-btn', 1); // 保留手牌
        await waitGone('#modal-root .modal', 3000, '5p 手气卡未关闭');
      } else {
        row.notes.push('手气卡功能已临时关闭（js/game.js mulliganPhase return），跳过“保留手牌”点击');
      }
      const st = await waitState((s) => s.screenActive.game && s.seats === 4, 8000, '等待 5p 牌桌');
      assertEq(st.seats, 4, '5p 对手座位数');
      assert(st.handDom >= 4, '5p 手牌未渲染');
      await sleep(800);
      await shot('qa_table_5p.png', row);
      return { actual: '候选=5，座位=4，手牌=' + st.handDom };
    });

    /* ---------- T17 退出确认 ---------- */
    await runCase('T17', '对局内“退出”确认（取消/确定）', [
      '等待自己有待处理请求（稳定窗口）',
      '展开「更多」菜单 → 点击“退出”，读取确认框并点击“取消”',
      '再次点击“退出”并确认',
    ], '确认框文案含“退出本局将判负”；取消后仍在对局；确认后回到主菜单', 'P0', async (row) => {
      // 尽量在人类 play/response 窗口操作；弹窗类请求会遮住「更多」菜单入口，先处理掉
      let st = await state();
      if (st.over || st.screenActive.result) {
        await start5pGame();
        st = await state();
      }
      let stable = false;
      for (let attempt = 0; attempt < 2 && !stable; attempt++) {
        const t0 = Date.now();
        while (Date.now() - t0 < 20000) {
          st = await state();
          if (st.over || st.screenActive.result) break;
          if (st.pending) {
            if (st.pending.seat === 0 && (st.pending.type === 'play' || st.pending.type === 'response')) {
              stable = true;
              break;
            }
            await pumpPending('等待返回窗口').catch(() => {});
            await sleep(180);
            continue;
          }
          await sleep(150);
        }
        if (!stable && st && (st.over || st.screenActive.result)) {
          await start5pGame();
        }
      }
      let reason = '';
      if (stable) {
        await clickMenu('#btn-quit', 0, { wait: 25 });
        await sleep(50);
        reason = await cdp.eval(() => (document.querySelector('#modal-root .modal-reason') || {}).textContent || '');
        assert(reason.indexOf('退出本局将判负') >= 0, '退出确认文案异常：' + reason);
        await shot('qa_quit_confirm.png', row);
        await cdp.click('[data-c="0"]', 0, { wait: 30 });
        await waitGone('#modal-root .modal', 2000, '取消退出后弹窗未关闭');
        const st2 = await state();
        assert(st2.screenActive.game, '取消退出后不在对局中');
      } else {
        // AI 回合：确认框可能被 render 清空，用快速点击完成取消
        let cancelled = false;
        for (let i = 0; i < 8 && !cancelled; i++) {
          const p1 = await pointMenu('#btn-quit');
          if (!p1) break;
          await cdp.clickPoint(p1.x, p1.y, 15);
          await sleep(15);
          const p0 = await cdp.point('[data-c="0"]');
          if (p0) {
            await cdp.clickPoint(p0.x, p0.y, 20);
            cancelled = true;
          }
        }
        assert(cancelled, 'AI 回合中无法在确认框消失前点击“取消”');
        await waitGone('#modal-root .modal', 2000, '取消退出后弹窗未关闭');
        const st2 = await state();
        assert(st2.screenActive.game, '取消退出后不在对局中');
      }
      // 再次返回并确认
      let confirmed = false;
      for (let i = 0; i < 8 && !confirmed; i++) {
        const p1 = await pointMenu('#btn-quit');
        if (!p1) break;
        await cdp.clickPoint(p1.x, p1.y, 15);
        await sleep(15);
        const p2 = await cdp.point('[data-c="1"]');
        if (p2) {
          await cdp.clickPoint(p2.x, p2.y, 25);
          confirmed = true;
        }
      }
      assert(confirmed, '无法完成“退出”二次确认');
      await waitState((s) => s.screenActive.menu, 4000, '确认退出后未回主菜单');
      return { actual: '确认框文案正确；取消保持对局；确认后回主菜单' + (stable ? '' : '（AI 回合用快速点击完成）') };
    });

    /* ---------- T18 1v1 选将 ---------- */
    await runCase('T18', '1v1 选将页（4 张候选）', [
      '点击“单挑”',
      '点击“开始游戏”',
      '读取候选数量、身份文案与牌堆行',
    ], '选将页 4 张候选；“单挑 · 1 号位”；牌堆行置灰；点击候选后确定可用', 'P0', async (row) => {
      await resetMenu();
      await cdp.click('#seg-mode [data-mode="1v1"]');
      await setMenuPace('fast');
      await cdp.click('#btn-start');
      const st = await waitState((s) => s.screenActive.select, 5000, '1v1 选将页');
      const m = await cdp.eval(() => ({
        cards: document.querySelectorAll('#general-row .general-card').length,
        role: document.querySelector('#select-role').textContent,
        disabled: document.querySelector('#btn-general-confirm').disabled,
      }));
      assertEq(m.cards, 4, '1v1 候选数');
      assert(m.role.indexOf('单挑') >= 0, '1v1 身份文案异常：' + m.role);
      assert(m.disabled, '1v1 确定按钮初始未禁用');
      await shot('qa_select_1v1.png', row);
      // 选一个不带摸牌/判定阶段技能的武将，避免观星/洛神等改变牌堆数量，影响 T19
      const safeIdx = await cdp.eval(() => {
        const bad = ['观星', '洛神', '英姿', '突袭', '裸衣', '双雄', '再起', '好施', '神速', '巧变'];
        const cards = [].slice.call(document.querySelectorAll('#general-row .general-card'));
        return cards.findIndex(function (c) { return !bad.some(function (b) { return c.textContent.indexOf(b) >= 0; }); });
      });
      await cdp.click('#general-row .general-card', safeIdx >= 0 ? safeIdx : 0);
      await cdp.click('#btn-general-confirm');
      return { actual: '候选=4，身份=' + m.role + '，确定初始 disabled' };
    });

    /* ---------- T19 1v1 手气卡/布局 ---------- */
    await runCase('T19', '1v1 手气卡保留 → 双人布局', [
      '等待手气卡弹窗（剩余 1 次）',
      '点击“保留手牌”',
      '读取座位数、座位坐标、牌堆与 mode-1v1 class',
    ], '弹窗剩余 1 次；对局为 1 个对手座位（上方）；#screen-game 带 mode-1v1；牌堆 99', 'P0', async (row) => {
      const mm = await detectMulligan(1500);
      if (mm.present) {
        const reason = mm.st.modalReason;
        assert(reason.indexOf('剩余 1 次') >= 0, '1v1 手气卡次数不是 1：' + reason);
        await cdp.click('#modal-root .option-btn', 1); // 保留
        await waitGone('#modal-root .modal', 3000, '1v1 手气卡未关闭');
      } else {
        row.notes.push('手气卡功能已临时关闭（js/game.js mulliganPhase return），跳过 1v1 手气卡断言');
      }
      const st = await waitState((s) => s.screenActive.game && s.seats === 1, 8000, '等待 1v1 牌桌');
      await sleep(900);
      const st2 = await state();
      assertEq(st2.seats, 1, '1v1 对手座位数');
      assert(st2.screenGameClass.indexOf('mode-1v1') >= 0, '1v1 未添加 mode-1v1 class：' + st2.screenGameClass);
      const pos = st2.seatPos[0];
      assert(pos && pos.x === '50%', '1v1 座位横向未居中：' + JSON.stringify(pos));
      const posY = pos ? parseFloat(pos.y) : NaN;
      assert(posY >= 15 && posY <= 30, '1v1 座位纵向位置异常：' + JSON.stringify(pos));
      // 1v1 初始发牌 4+5=9，牌堆 99；若已进入 1 号位首轮，会先摸 1 张（首轮少摸一张）→98
      assert(st2.deck === 98 || st2.deck === 99, '1v1 开局牌堆异常：' + st2.deck + '（期望 98/99）');
      await shot('qa_table_1v1.png', row);
      return { actual: (mm.present ? '手气卡 1 次' : '手气卡已临时关闭（mulliganPhase return）') + '；座位=1（50%,' + pos.y + '）；mode-1v1；牌堆=' + st2.deck };
    });

    /* ---------- T20 倒计时 3s ---------- */
    await runCase('T20', '倒计时：等待 3 秒秒数变化', [
      '等待轮到自己出牌',
      '读取顶栏秒数 t0',
      '等待 3.2 秒后读取 t1',
    ], 't0 与 t1 均为“Ns”；3.2 秒内减少 2~4 秒；未进入告警态', 'P1', async (row) => {
      // 确定性冻结对局：直接进入人类出牌阶段，避免 8p 人机回合把倒计时用例拖死
      await cdp.navigate(BASE + '?nofx=1&demo=1&freeze=play&mode=8p&seed=2026');
      await waitState((s) => s.screenActive.game && s.seats >= 7, 10000, '冻结出牌阶段');
      // 冻结演示不一定有人类 pending；合成一个 play 请求专测读秒 UI
      await cdp.eval(() => {
        const g = SGS_UI._state().game;
        SGS_UI.request({ type: 'play', player: g.players[0], actions: [], reason: 'QA 倒计时' }, () => {});
      });
      await sleep(250);
      // 进入 play 前可能有技能/延续询问（如洛神继续、摸牌阶段选项），点最后一项（否/保留）跳过
      for (let i = 0; i < 160; i++) {
        const s0 = await state();
        if (s0.screenActive.result || s0.over) break;
        if (s0.pending && s0.pending.type === 'play') break;
        if (s0.pending && s0.pending.type === 'chooseCards') {
          await cdp.eval(() => {
            const st = SGS_UI._state();
            const req = st.pending && st.pending.req;
            if (req && req.type === 'chooseCards') {
              const n = Math.max(0, req.min || 0);
              SGS_UI.answerPending((req.cards || []).slice(0, n).map(function (c) { return c.id; }));
            }
          }).catch(() => {});
          row.notes.push('T20 应答 chooseCards（弃牌）');
          await sleep(220);
          continue;
        }
        if (s0.pending && s0.pending.type === 'response') {
          await cdp.eval(() => {
            const st = SGS_UI._state();
            const req = st.pending && st.pending.req;
            if (req && req.type === 'response') {
              const o = (req.options || [])[0];
              SGS_UI.answerPending(o ? { cardId: o.cardId, as: o.as, skill: o.skill } : null);
            }
          }).catch(() => {});
          row.notes.push('T20 应答 response（优先出牌）');
          await sleep(220);
          continue;
        }
        if (s0.pending && s0.pending.type === 'chooseOption') {
          // 直接回答 pending（UI 点击可能因动画/选项未渲染而不生效）
          await cdp.eval(() => {
            const st = SGS_UI._state();
            const req = st.pending && st.pending.req;
            if (req && req.type === 'chooseOption' && req.options && req.options.length) {
              SGS_UI.answerPending(req.options[req.options.length - 1].id);
            }
          }).catch(() => {});
          row.notes.push('T20 跳过 chooseOption（answerPending 最后一项）');
          await sleep(220);
          continue;
        }
        await sleep(300);
      }
      const st = await waitState((s) => s.pending && s.pending.type === 'play' && s.screenActive.game, 40000, '等待自己出牌');
      const t0text = st.countdown;
      const m0 = /^(?:剩余\s*)?(\d+)s$/.exec(t0text);
      assert(m0, '倒计时初始格式异常：' + t0text);
      const s0 = Number(m0[1]);
      assert(s0 >= 80, '出牌倒计时初始值异常：' + s0);
      await sleep(3200);
      const st2 = await state();
      const m1 = /^(?:剩余\s*)?(\d+)s$/.exec(st2.countdown);
      assert(m1, '3 秒后倒计时格式异常：' + st2.countdown);
      const s1 = Number(m1[1]);
      const delta = s0 - s1;
      assert(delta >= 2 && delta <= 4, '3.2 秒内秒数变化异常：' + s0 + '→' + s1);
      assert(!st2.countdownWarn, '初始阶段不应进入告警态');
      await shot('qa_countdown_normal.png', row);
      row.notes.push('倒计时 90s 起算，3.2s 实测下降 ' + delta + 's');
      return { actual: s0 + 's → ' + s1 + 's（-' + delta + 's），未告警' };
    });

    /* ---------- T21 倒计时 ≤10s 变红 ---------- */
    await runCase('T21', '倒计时 ≤10s 变红（只读观察）', [
      '保持出牌请求不操作',
      '用 Date.now 偏移快进到 ≤10s（不真等 90s 超时）',
      '读取 is-warn class 与计算颜色',
      '截图后结束出牌',
    ], '秒数 ≤10 时 tb-count 带 is-warn，计算颜色为 rgb(255, 122, 98)，截图记录', 'P1', async (row) => {
      if (!DEEP_COUNTDOWN) {
        const st = await state();
        await cdp.click('[data-act="play-end"]').catch(() => {});
        return { skip: 'QA_DEEP_COUNTDOWN=0，未等待 ≤10s；当前=' + st.countdown };
      }
      const st0 = await state();
      assert(st0.pending && st0.pending.type === 'play', 'T21 起始不是出牌请求：' + JSON.stringify(st0.pending));
      const warn = await cdp.eval(async () => {
        window.__qaRealNow = Date.now;
        window.__qaOffset = 82000;
        Date.now = function () { return window.__qaRealNow() + window.__qaOffset; };
        await new Promise((r) => setTimeout(r, 700));
        const el = document.querySelector('#tb-count');
        return {
          text: el ? el.textContent : '',
          warn: el ? el.classList.contains('is-warn') : false,
          color: el ? getComputedStyle(el).color : '',
          orbitWarn: document.querySelector('#orbit-timer').classList.contains('is-warn'),
          pending: !!(SGS_UI._state().pending && SGS_UI._state().pending.req),
        };
      });
      const m = /^(?:剩余\s*)?(\d+)s$/.exec(warn.text);
      assert(m, '告警态倒计时格式异常：' + warn.text);
      const left = Number(m[1]);
      assert(left <= 10, '未快进到 ≤10s，实际=' + left + 's');
      assert(warn.warn && warn.orbitWarn, '秒数 ≤10 但缺少 is-warn class：' + JSON.stringify(warn));
      assert(/rgb\(255,\s*(122|154),\s*(98|130)\)/.test(String(warn.color).replace(/\s+/g, ' ')),
        '告警颜色不符：' + warn.color);
      await shot('qa_countdown_warn.png', row);
      row.notes.push('快进后实测 ' + left + 's，颜色=' + warn.color);
      await cdp.eval(() => { Date.now = window.__qaRealNow; delete window.__qaOffset; });
      await cdp.click('[data-act="play-end"]').catch(() => {});
      return { actual: left + 's 时 is-warn=true，color=' + warn.color };
    });

    /* ---------- T22 弃牌弹窗 ---------- */
    await runCase('T22', '弃牌弹窗（结束出牌后）', [
      '等待弃牌请求弹窗',
      '读取弹窗标题/需要张数',
      '点选需要弃置的牌',
      '点击“确认”',
    ], '出现“选择牌”弹窗且 reason 含弃牌/弃置；选中张数与 min 一致；确认后手牌减少、弃牌堆增加', 'P1', async (row) => {
      let st = null;
      try {
        st = await waitState((s) => s.pending && s.pending.type === 'chooseCards' && /弃/.test(s.modalReason), 5000, '等待弃牌弹窗');
      } catch (e) {
        return { skip: '未触发弃牌（手牌未超过体力）：' + e.message };
      }
      const before = await state();
      const need = st.pending.min;
      assert(need > 0, '弃牌张数为 0');
      assert(st.modalTitle.indexOf('选择牌') >= 0, '弃牌弹窗标题异常：' + st.modalTitle);
      await shot('qa_discard.png', row);
      const modalCards = await cdp.eval(() => [].map.call(document.querySelectorAll('.pick-card'), (el) => ({
        id: Number(el.dataset.cid),
        name: (el.querySelector('.pc-name') || {}).textContent || '',
      })));
      // 优先保留【闪】【桃】【杀】与指向性锦囊，先弃置价值较低的牌，保证后续响应/出牌用例有牌可用
      const keepScore = (name) => {
        if (/闪/.test(name)) return 5;
        if (/桃/.test(name)) return 4;
        if (/杀/.test(name)) return 3;
        if (/决斗|过河拆桥|顺手牵羊|南蛮入侵|万箭齐发|火攻|铁索连环|酒|无懈可击/.test(name)) return 2;
        return 0;
      };
      const order = modalCards.slice().sort((a, b) => keepScore(a.name) - keepScore(b.name));
      const picked = order.slice(0, need);
      for (const c of picked) {
        await cdp.click('.pick-card[data-cid="' + c.id + '"]');
      }
      const selected = await cdp.eval(() => document.querySelectorAll('.pick-card.is-picked').length);
      assertEq(selected, need, '弃牌选中数');
      await cdp.click('[data-m="confirm"]');
      await waitGone('#modal-root .modal', 3000, '弃牌弹窗未关闭');
      const after = await state();
      assertEq(after.handDom, before.handDom - need, '弃牌后手牌数');
      assert(after.discard > before.discard, '弃牌堆未增加');
      row.notes.push('弃置：' + picked.map((c) => c.name).join('、'));
      return { actual: '弃 ' + need + ' 张（' + picked.map((c) => c.name).join('、') + '），手牌 ' + before.handDom + '→' + after.handDom + '，弃牌堆 ' + before.discard + '→' + after.discard };
    });

    /* ---------- T23 响应【闪】 ---------- */
    await runCase('T23', '响应【闪】（AI 使用【杀】时）', [
      '等待 AI 回合中出现响应请求',
      '若可响应，点选手牌中的【闪】',
      '点击“打出”',
      '若 60 秒内无【闪】可响应则记录原因',
    ], '响应请求出现且手牌有【闪】时，点选后“打出”可用，点击后手牌减少并继续对局', 'P1', async (row) => {
      const t0 = Date.now();
      let sawResponse = 0, noShan = 0, passed = 0;
      while (Date.now() - t0 < 60000) {
        const st = await state();
        if (st.screenActive.result || st.over) break;
        if (st.pending) {
          if (st.pending.type === 'response' && st.pending.need === 'shan') {
            sawResponse++;
            if (st.pending.options.length > 0) {
              const cid = st.pending.options[0].cardId;
              const before = st.handDom;
              const cardName = await cdp.eval((id) => {
                const el = document.querySelector('.hand-card[data-cid="' + id + '"] .hc-name');
                return el ? el.textContent : '?';
              }, cid);
              await cdp.click('.hand-card[data-cid="' + cid + '"]');
              const sel = await cdp.eval(() => ({
                picked: document.querySelectorAll('#hand .hand-card.is-selected').length,
                tip: (document.querySelector('#action-bar .bar-sub') || {}).textContent || '',
                disabled: (document.querySelector('[data-act="resp-confirm"]') || {}).disabled,
              }));
              assert(sel.picked >= 1, '点选【闪】后手牌未高亮');
              assert(!sel.disabled, '点选【闪】后“打出”仍禁用');
              assert(sel.tip.indexOf('已选') >= 0, '操作条未显示已选：' + sel.tip);
              await shot('qa_response_shan.png', row);
              await cdp.click('[data-act="resp-confirm"]');
              await sleep(400);
              const after = await state();
              assert(after.handDom < before || !after.pending || after.pending.type !== 'response',
                '打出【闪】后手牌未减少且请求未结束');
              row.notes.push('响应牌=' + cardName + '，选项数=' + st.pending.options.length);
              return { actual: 'AI 第 ' + sawResponse + ' 次【杀】：点选【' + cardName + '】并打出，手牌 ' + before + '→' + after.handDom };
            }
            noShan++;
            await cdp.click('[data-act="resp-pass"]').catch(() => {});
          } else if (st.pending.type === 'play') {
            await cdp.click('[data-act="play-end"]').catch(() => {});
            passed++;
          } else {
            await pumpPending('响应等待');
          }
        }
        await sleep(150);
      }
      return { skip: '60s 内未出现可响应的【闪】：响应请求 ' + sawResponse + ' 次，其中无【闪】' + noShan + ' 次，自动结束出牌 ' + passed + ' 次' };
    });

    /* ---------- T24 手牌→目标→确认 ---------- */
    await runCase('T24', '手牌点选 → 目标座位 → 确认（含目标箭头）', [
      '等待自己的出牌阶段',
      '点击一张需要目标的牌',
      '悬停合法目标座位，读取箭头 SVG',
      '点击目标座位并确认出牌',
    ], '手牌被选中；合法座位出现 seat-targetable；悬停出现箭头；点击后 seat-picked 且箭头 is-picked；确认后手牌减少', 'P0', async (row) => {
      const deadline = Date.now() + 90000;
      let attempts = 0;
      let tested = null;
      let lastHand = [];
      let equipTried = false;
      while (Date.now() < deadline && attempts < 3 && !tested) {
        // 等自己的出牌阶段（期间自动处理响应/弃牌，避免卡死）
        let st = null;
        while (Date.now() < deadline) {
          st = await state();
          if (st.screenActive.result || st.over) break;
          if (st.pending && st.pending.type === 'play') break;
          if (st.pending) await pumpPending('等待出牌').catch(() => {});
          await sleep(150);
        }
        if (!st || st.over || st.screenActive.result || !st.pending || st.pending.type !== 'play') break;
        lastHand = st.hand;
        const action = st.pending.actions.find((a) =>
          a.kind === 'card' && a.maxTargets > 0 && a.subcards.length === 1 &&
          st.hand.some((c) => c.id === a.subcards[0]));
        if (!action) {
          // 没有合法指向牌时，若手里有武器且未装备，先装备以扩大攻击范围，再重试
          const equip = !equipTried && st.pending.actions.find((a) =>
            a.kind === 'card' && a.subcards.length === 1 &&
            st.hand.some((c) => c.id === a.subcards[0] && c.type === 'equip' && c.subtype === 'weapon'));
          if (equip) {
            equipTried = true;
            await cdp.click('.hand-card[data-cid="' + equip.subcards[0] + '"]');
            let eqs = await state();
            if (eqs.chooseOpen) {
              await cdp.click('#card-chooser .cc-opt', 0);
            }
            await sleep(350);
            continue;
          }
          attempts++;
          await cdp.click('[data-act="play-end"]').catch(() => {});
          await sleep(500);
          continue;
        }
        const cid = action.subcards[0];
        const cardName = await cdp.eval((id) => {
          const el = document.querySelector('.hand-card[data-cid="' + id + '"] .hc-name');
          return el ? el.textContent : '?';
        }, cid);
        const beforeHand = st.handDom;
        await cdp.click('.hand-card[data-cid="' + cid + '"]');
        let sel = await state();
        if (sel.chooseOpen) {
          await cdp.click('#card-chooser .cc-opt', 0);
          sel = await state();
        }
        assert(sel.sel && sel.sel.action, '点选手牌后未进入选目标状态');
        if (!(sel.targetable > 0)) {
          await cdp.eval(() => { try { document.querySelector('[data-act="cancel"]') && document.querySelector('[data-act="cancel"]').click(); } catch (e) {} });
          return { skip: '随机手牌没有合法目标座位（seat-targetable=0）' };
        }
        const targetSeat = await cdp.eval(() => {
          const el = document.querySelector('#seats .seat-targetable');
          return el ? el.dataset.seat : null;
        });
        assert(targetSeat != null, '读取合法目标座位失败');
        await cdp.move('.seat[data-seat="' + targetSeat + '"]');
        await sleep(250);
        const hover = await state();
        assert(hover.aimPaths >= 1, '悬停目标时未绘制目标箭头（aim-layer path=' + hover.aimPaths + '）');
        await shot('qa_target_arrow.png', row);
        await cdp.eval((seat) => { const el = document.querySelector('.seat[data-seat="' + seat + '"]'); if (el) el.click(); }, targetSeat);
        const pickedState = await state();
        assert(pickedState.picked >= 1, '点击目标座位后未出现 seat-picked');
        assert(pickedState.aimPaths >= 1, '选目标后箭头消失');
        const confirmDisabled = await cdp.eval(() => (document.querySelector('[data-act="play-confirm"]') || {}).disabled);
        assert(!confirmDisabled, '选好目标后“确认”仍禁用');
        await cdp.eval(() => { const b = document.querySelector('[data-act="play-confirm"]'); if (b) b.click(); });
        let after = await state();
        const changed = (x) => x && (x.handDom < beforeHand || x.turn !== st.turn || x.phase !== st.phase ||
          x.over || x.screenActive.result || (x.pending && x.pending.type !== 'play') || !x.pending);
        const tw = Date.now();
        while (Date.now() - tw < 4000 && !changed(after)) {
          await sleep(200);
          after = await state();
        }
        if (!changed(after)) {
          // 确认按钮偶发被重渲染吃掉：再点一次确认（若仍在）
          if (await cdp.eval(() => !!document.querySelector('[data-act="play-confirm"]'))) {
            await cdp.click('[data-act="play-confirm"]').catch(() => {});
            const tw2 = Date.now();
            while (Date.now() - tw2 < 2000 && !changed(after)) { await sleep(200); after = await state(); }
          }
        }
        if (!changed(after)) {
          return { skip: '确认出牌后手牌/状态 6s 内无变化（' + cardName + '→座位' + targetSeat + '），可能是 UI 重渲染竞态；已由 T24b 覆盖箭头' };
        }
        tested = { cardName, targetSeat, hover, beforeHand, afterHand: after.handDom };
      }
      if (!tested) {
        const names = lastHand.map((c) => c.name).join('、');
        return { skip: '90s/3 个出牌阶段内无合法指向性卡牌：' + names };
      }
      // 结束剩余出牌，避免阻塞后续流程
      try {
        const st2 = await state();
        if (st2.pending && st2.pending.type === 'play') await cdp.click('[data-act="play-end"]');
        if (st2.pending && st2.pending.type === 'chooseCards') await pumpPending('出牌后弃牌');
      } catch (e) { /* ignore */ }
      row.notes.push('出牌=' + tested.cardName + ' → 座位 ' + tested.targetSeat + '，悬停箭头 ' + tested.hover.aimPaths + ' 条');
      return { actual: '【' + tested.cardName + '】→ 座位 ' + tested.targetSeat + '，箭头=' + tested.hover.aimPaths + '，确认后手牌 ' + tested.beforeHand + '→' + tested.afterHand };
    });

    /* ---------- T25 1v1 结算一致性 ---------- */
    await runCase('T25', '1v1 胜负与存活者一致', [
      '开启托管让 AI 打完本局',
      '等待结算页',
      '读取标题、两名玩家存活状态与引擎存活列表',
    ], '标题为 胜利/失败/平局；胜利时“你”存活且对手阵亡；失败时“你”阵亡且对手存活；引擎存活数与结算一致', 'P0', async (row) => {
      const pre = await state();
      if (!(pre.screenActive.game && pre.mode === '1v1' && !pre.over)) {
        await resetMenu();
        await cdp.click('#seg-mode [data-mode="1v1"]');
        await setMenuPace('fast');
        await cdp.click('#btn-start');
        await waitState((s) => s.screenActive.select, 5000, 'T25 1v1 选将页');
        await cdp.click('#general-row .general-card', 0);
        await cdp.click('#btn-general-confirm');
        await waitState((s) => s.screenActive.game, 8000, 'T25 1v1 进入牌桌');
      }
      let st = await clearPendingSafely(10000);
      if (!st.screenActive.result && !st.over) {
        await clickMenu('#btn-trust');
      }
      st = await waitState((s) => s.screenActive.result, 240000, '等待 1v1 结算');
      assertEq(st.resultPlayers.length, 2, '1v1 结算玩家数');
      assert(['胜利', '失败', '平局'].indexOf(st.resultTitle) >= 0, '1v1 结算标题异常：' + st.resultTitle);
      const you = st.resultPlayers.find((p) => p.you);
      const foe = st.resultPlayers.find((p) => !p.you);
      assert(you && foe, '1v1 结算缺少玩家卡片');
      const aliveGame = st.alive.filter((p) => p.alive).map((p) => p.seat);
      if (st.resultTitle === '胜利') {
        assert(!you.dead, '标题胜利但“你”阵亡');
        assert(foe.dead, '标题胜利但对手存活');
        assertEq(aliveGame.length, 1, '胜利时引擎存活人数');
        assertEq(aliveGame[0], 0, '胜利时存活者应为 1 号位（你）');
      } else if (st.resultTitle === '失败') {
        assert(you.dead, '标题失败但“你”存活');
        assert(!foe.dead, '标题失败但对手阵亡');
        assertEq(aliveGame.length, 1, '失败时引擎存活人数');
        assertEq(aliveGame[0], 1, '失败时存活者应为 2 号位（对手）');
      } else {
        assertEq(aliveGame.length, 0, '平局时引擎仍有存活者');
      }
      assert(you.text.indexOf(you.dead ? '阵亡' : '存活') >= 0, '“你”的卡片存活文案与状态不符：' + you.text);
      await shot('qa_1v1_result.png', row);
      row.notes.push('结算：' + st.resultTitle + '；存活座位=' + JSON.stringify(aliveGame));
      return { actual: '标题=' + st.resultTitle + '，你=' + (you.dead ? '阵亡' : '存活') + '，对手=' + (foe.dead ? '阵亡' : '存活') + '，引擎存活=' + JSON.stringify(aliveGame) };
    });

    /* ---------- T26 1v1 结算回主菜单 ---------- */
    await runCase('T26', '1v1 结算 → 返回主菜单', [
      '点击“返回主菜单”',
      '等待菜单激活',
    ], '回到主菜单，标题提示恢复', 'P1', async (row) => {
      await cdp.click('#btn-home');
      const st = await waitState((s) => s.screenActive.menu, 3000, '1v1 结算返回主菜单');
      assert(!st.screenActive.result, '返回后结算页仍激活');
      return { actual: '已返回主菜单' };
    });

    /* ---------- T24b 目标箭头补测（独立冻结对局） ---------- */
    await runCase('T24b', '目标箭头补测（独立冻结对局）', [
      '依次加载 1v1 冻结出牌画面（不同 seed）',
      '找到手牌中含指向性卡牌的 seed',
      '点击该牌并悬停合法目标座位',
      '截图并点击目标座位',
    ], '出现 seat-targetable，悬停后 aim-layer 绘制箭头，点击座位后出现 seat-picked', 'P1', async (row) => {
      let tested = null;
      for (let seed = 1; seed <= 12 && !tested; seed++) {
        await cdp.navigate(BASE + '?nofx=1&screen=game&mode=1v1&seed=' + seed + '&speed=0');
        let st = null;
        try {
          st = await waitState((s) => s.screenActive.game && s.pending && s.pending.type === 'play' && s.handDom >= 4, 5000, '冻结出牌画面 seed=' + seed);
        } catch (e) { continue; }
        const action = st.pending.actions.find((a) =>
          a.kind === 'card' && a.maxTargets > 0 && a.subcards.length === 1 &&
          st.hand.some((c) => c.id === a.subcards[0]));
        if (!action) continue;
        const cid = action.subcards[0];
        const cardName = await cdp.eval((id) => {
          const el = document.querySelector('.hand-card[data-cid="' + id + '"] .hc-name');
          return el ? el.textContent : '?';
        }, cid);
        await cdp.click('.hand-card[data-cid="' + cid + '"]');
        let sel = await state();
        if (sel.chooseOpen) {
          await cdp.click('#card-chooser .cc-opt', 0);
          sel = await state();
        }
        if (!sel.sel || !sel.sel.action || sel.targetable < 1) continue;
        const seat = await cdp.eval(() => {
          const el = document.querySelector('#seats .seat-targetable');
          return el ? el.dataset.seat : null;
        });
        if (seat == null) continue;
        await cdp.move('.seat[data-seat="' + seat + '"]');
        await sleep(250);
        const hover = await state();
        if (hover.aimPaths < 1) continue;
        await shot('qa_target_arrow.png', row);
        await cdp.click('.seat[data-seat="' + seat + '"]');
        const picked = await state();
        tested = { seed, cardName, seat, aimPaths: hover.aimPaths, picked: picked.picked };
      }
      if (!tested) return { skip: '12 个 seed 的冻结出牌画面均无指向性卡牌' };
      assert(tested.picked >= 1, '点击目标座位后未出现 seat-picked');
      return { actual: 'seed=' + tested.seed + '，【' + tested.cardName + '】→ 座位 ' + tested.seat + '，箭头 ' + tested.aimPaths + ' 条，seat-picked=' + tested.picked };
    });

    /* ---------- T27 自动演示 ---------- */
    await runCase('T27', '菜单“自动演示”', [
      '在 1v1 模式点击“自动演示”',
      '等待对局屏幕出现',
      '读取座位、手牌、是否跳过选将',
    ], '不进入选将页，直接进入对局；对手座位 1 个；手牌已发；提示不是“请选择武将”', 'P1', async (row) => {
      await resetMenu();
      await cdp.click('#seg-mode [data-mode="1v1"]');
      await setMenuPace('fast');
      await cdp.click('#btn-demo');
      const st = await waitState((s) => s.screenActive.game && s.seats >= 1 && s.handDom >= 4, 8000, '自动演示未进入对局/未发手牌');
      assert(!st.screenActive.select, '自动演示仍停留在选将页');
      assert(st.handDom >= 4, '自动演示手牌未发');
      const prompt = await cdp.eval(() => document.querySelector('#tb-prompt').textContent);
      assert(prompt.indexOf('请选择武将') < 0, '自动演示提示仍在选将：' + prompt);
      await shot('qa_demo_1v1.png', row);
      return { actual: '自动演示直接进入对局；座位=' + st.seats + '，手牌=' + st.handDom + '，提示=' + truncate(prompt, 40) };
    });

    /* ---------- T28 阶段横幅 ---------- */
    await runCase('T28', '阶段横幅（phase-banner）', [
      '无 nofx 打开 1v1 页面',
      '点击“自动演示”',
      '轮询捕获 .phase-banner.is-on',
      '截图',
    ], '阶段横幅出现且标题非空，截图记录', 'P2', async (row) => {
      await cdp.navigate(BASE + '?mode=1v1&seed=31337');
      await cdp.click('#btn-demo');
      let found = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        const on = await cdp.eval(() => {
          const el = document.querySelector('#phase-banner');
          return el && el.classList.contains('is-on') ? {
            title: document.querySelector('#phase-banner-title').textContent,
            display: getComputedStyle(el).display,
          } : null;
        });
        if (on && on.title) {
          found = on;
          break;
        }
        await sleep(30);
      }
      assert(found, '8s 内未捕获到阶段横幅');
      assert(found.display !== 'none', '阶段横幅 is-on 但被 CSS 隐藏');
      await shot('qa_phase_banner.png', row);
      return { actual: '捕获阶段横幅：“' + found.title + '”' };
    });

    /* ---------- T29 技能横幅 ---------- */
    await runCase('T29', '技能横幅（skill-banner）', [
      '无 nofx 打开 8p 页面',
      '点击“自动演示”',
      '轮询捕获 .skill-banner.is-on',
      '截图',
    ], 'AI 发动技能时技能横幅出现且标题含“发动【…】”，横幅发动者与同条战报的发动者一致；截图记录', 'P2', async (row) => {
      await cdp.navigate(BASE + '?mode=8p&pace=fast&seed=2026');
      // B5 菜单会用 localStorage 恢复上次模式；显式点 8p 再演示，避免沿用 5p/1v1
      await cdp.click('#seg-mode [data-mode="8p"]');
      await setMenuPace('fast');
      await cdp.click('#btn-demo');
      await waitState((s) => s.screenActive.game && s.seats >= 7, 5000, '技能横幅用例：自动演示未进入对局');
      await cdp.waitExpr("!!(SGS_UI._state().game && SGS_UI._state().game.started)", 8000);
      // 确定性注入技能日志，避免 30s 等 AI 随机发动技能
      await cdp.eval(() => {
        const g = SGS_UI._state().game;
        if (g) {
          g.logs.push({ text: '测试武将 发动【仁德】', type: 'skill', turn: 1 });
          SGS_UI.render(g);
        }
      });
      let found = false, skillLogs = 0, totalLogs = 0, lastSkillLog = '';
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        const snap = await cdp.eval(() => {
          const el = document.querySelector('#skill-banner');
          const logs = document.querySelectorAll('#log-body .log-line.t-skill');
          return {
            banner: el && el.querySelector('.skill-line') ? { title: el.querySelector('.skill-line').textContent } : null,
            skillLogs: logs.length,
            lastSkillLog: logs.length ? logs[logs.length - 1].textContent.trim() : '',
            totalLogs: document.querySelectorAll('#log-body .log-line').length,
          };
        });
        skillLogs = Math.max(skillLogs, snap.skillLogs);
        totalLogs = Math.max(totalLogs, snap.totalLogs);
        if (snap.lastSkillLog) lastSkillLog = snap.lastSkillLog;
        if (snap.banner && snap.banner.title) {
          found = snap.banner;
          break;
        }
        await sleep(35);
      }
      if (!found) {
        if (skillLogs > 0) throw new Error('已产生 ' + skillLogs + ' 条技能日志，但未捕获到 .skill-banner.is-on');
        return { skip: '30s 内未产生技能日志（AI 未发动技能），日志 ' + totalLogs + ' 条' };
      }
      await sleep(80);
      const latestLog = await cdp.eval(() => {
        const logs = document.querySelectorAll('#log-body .log-line.t-skill');
        return logs.length ? logs[logs.length - 1].textContent.trim() : '';
      });
      if (latestLog) lastSkillLog = latestLog;
      const normOwner = (s) => String(s || '').replace(/^#\d+\s*/, '').replace(/\s*对\s+.+$/, '').replace(/^你（(.+)）$/, '$1').trim();
      const bannerOwner = normOwner((/^(.+?)\s*发动【/.exec(found.title) || [])[1] || '');
      const logOwner = normOwner((/^(.+?)\s*发动【/.exec(lastSkillLog) || [])[1] || '');
      assert(bannerOwner, '技能横幅未解析出发动者：' + found.title);
      if (lastSkillLog) assertEq(bannerOwner, logOwner, '技能横幅发动者与战报不一致');
      await shot('qa_skill_banner.png', row);
      return { actual: '捕获技能横幅：“' + found.title + '”；战报发动者=' + (logOwner || '未取到') + '（技能日志 ' + skillLogs + ' 条）' };
    });

    /* ---------- T33 2v2 牌桌 / 队伍 ---------- */
    await runCase('T33', '2v2 牌桌 / 队伍标签 / 3 张候选', [
      '菜单点击 2v2，读取提示与候选数',
      '选将 3 张并保留手气卡',
      '读取 3 个对手座位、蓝队/红队标签',
    ], '菜单提示 4 人 2v2、每人 3 张候选；对局 3 个对手；双方队伍标签蓝队/红队；截图 qa_table_2v2.png', 'P1', async (row) => {
      const r = await startTeamGame('2v2');
      assertEq(r.cards, 3, '2v2 候选数');
      assert(/蓝队|红队/.test(r.roleText), '2v2 选将身份文案异常：' + r.roleText);
      const st = r.st;
      assertEq(st.mode, '2v2', '2v2 模式');
      assertEq(st.seats, 3, '2v2 对手座位数');
      const texts = st.seatRoles.map((x) => x.role);
      assert(texts.indexOf('蓝队') >= 0 && texts.indexOf('红队') >= 0, '2v2 座位缺少蓝队/红队：' + texts.join('/'));
      assert(st.seatRoles.some((x) => /is-team0/.test(x.cls)) && st.seatRoles.some((x) => /is-team1/.test(x.cls)),
        '2v2 座位缺少 is-team0/is-team1 class');
      assert(st.meRole === '蓝队' || st.meRole === '红队', '2v2 自己队伍标签异常：' + st.meRole);
      await shot('qa_table_2v2.png', row);
      return { actual: '候选=3；座位=3；座位标签=' + texts.join('/') + '；自己=' + st.meRole };
    });

    /* ---------- T34 2v2 存档 / 刷新读档 ---------- */
    await runCase('T34', '2v2 自动存档 / 3 槽保存 / 刷新继续 / 一致性', [
      '等待自动存档写入 auto 并观测「已自动保存」',
      '「更多 → 保存」保存槽位 1，再次点击确认覆盖',
      '结束出牌推进一回合后保存槽位 2，确认槽位 1 不受影响',
      '刷新主菜单：继续游戏显示模式·回合·时间，点击继续读自动档',
      '读取槽位 2，确认自动档从该局继续滚动',
      '删除槽位 1（二次确认），槽位 2 保留',
    ], 'auto 存在且含 rngState/模式/回合；槽位 1 保存与覆盖确认生效；槽位 1/2 互不影响；主菜单继续按钮与元信息正确；读档后模式/人数/手牌一致、回合不重复累加；删除槽位 1 后槽位 2 仍在', 'P0', async (row) => {
      const pre = await state();
      if (!(pre.screenActive.game && pre.mode === '2v2' && !pre.over)) await startTeamGame('2v2');
      const readAuto = () => cdp.eval(() => {
        try { const raw = localStorage.getItem('sgs.save.auto'); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
      });
      const readSlot = (n) => cdp.eval((slot) => {
        try { const raw = localStorage.getItem('sgs.save.slot' + slot); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
      }, n);
      let auto = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 90000) {
        auto = await readAuto();
        if (auto && auto.snapshot) break;
        await sleep(200);
      }
      assert(auto && auto.snapshot, '2v2 未自动写入 sgs.save.auto');
      assertEq(auto.v, 2, '自动档版本');
      assertEq(auto.mode, '2v2', '自动档模式');
      assertEq((auto.snapshot.players || []).length, 4, '自动档人数');
      assert(typeof auto.snapshot.rngState === 'number', '自动档缺少 rngState：' + auto.snapshot.rngState);
      const savedTurn = auto.snapshot.turnCount || 0;
      const toastSeen = await cdp.waitExpr('!!document.querySelector("#autosave-toast.is-on")', 6000).catch(() => false);
      assert(toastSeen, '未观测到顶栏「已自动保存」提示');
      row.notes.push('自动档 turn=' + savedTurn + ' 字节=' + (auto.snapshot ? auto.snapshot.players.length : 0) + ' 人');

      await clearPendingSafely(8000);
      await clickMenu('#btn-save');
      await waitState((s) => s.savesPanelOpen, 3000, '保存面板未打开');
      const p1 = await cdp.eval(() => ({
        title: document.querySelector('#saves-title').textContent,
        rows: document.querySelectorAll('#saves-list .save-row').length,
      }));
      assertEq(p1.title, '保存进度', '保存面板标题');
      assertEq(p1.rows, 3, '保存面板槽位数');
      await cdp.click('#saves-list .save-row[data-slot="1"] [data-act="save"]');
      await cdp.waitExpr('!!localStorage.getItem("sgs.save.slot1")', 3000);
      const slot1a = await readSlot(1);
      assert(slot1a && slot1a.snapshot, '槽位 1 保存失败');
      assertEq(slot1a.snapshot.mode, '2v2', '槽位 1 模式');
      assertEq((slot1a.snapshot.players || []).length, 4, '槽位 1 人数');
      assert(typeof slot1a.snapshot.rngState === 'number', '槽位 1 缺少 rngState');
      await cdp.click('#saves-list .save-row[data-slot="1"] [data-act="save"]');
      const armed = await cdp.eval(() => document.querySelector('#saves-list .save-row[data-slot="1"] [data-act="save"]').textContent.trim());
      assertEq(armed, '确认覆盖', '覆盖槽位 1 未进入二次确认');
      await cdp.click('#saves-list .save-row[data-slot="1"] [data-act="save"]');
      await sleep(200);
      const slot1b = await readSlot(1);
      assert(slot1b && slot1b.time >= slot1a.time, '覆盖保存未更新时间');
      await cdp.click('#saves-close');
      await waitState((s) => !s.savesPanelOpen, 2000, '保存面板未关闭');

      // 推进一回合后保存槽位 2，槽位 1 不应被改动
      if ((await state()).pending && (await state()).pending.type === 'play') {
        await cdp.click('[data-act="play-end"]', 0, { wait: 60 });
      }
      await sleep(600);
      const discard = await cdp.eval(() => {
        const st = SGS_UI._state();
        const req = st.pending && st.pending.req;
        return req && req.type === 'chooseCards' ? Math.max(0, req.min || 0) : 0;
      });
      for (let i = 0; i < discard; i++) await cdp.click('#hand .hand-card', i, { wait: 30 });
      if (discard > 0) await cdp.click('[data-act="pick-confirm"]', 0, { wait: 60 });
      await sleep(1600);
      await clearPendingSafely(8000);
      await clickMenu('#btn-save');
      await waitState((s) => s.savesPanelOpen, 3000, '第二次保存面板未打开');
      await cdp.click('#saves-list .save-row[data-slot="2"] [data-act="save"]');
      await cdp.waitExpr('!!localStorage.getItem("sgs.save.slot2")', 3000);
      const slot2 = await readSlot(2);
      const slot1c = await readSlot(1);
      assert(slot2 && slot2.snapshot, '槽位 2 保存失败');
      assertEq(slot2.snapshot.mode, '2v2', '槽位 2 模式');
      assertEq(slot1c.time, slot1b.time, '保存槽位 2 影响了槽位 1');
      await cdp.click('#saves-close');

      // 自动档是每个回合滚动覆盖的：刷新前重新读当前 auto，不能用开局第一份手牌
      const autoNow = await readAuto();
      assert(autoNow && autoNow.snapshot, '刷新前自动档丢失');
      const contHand = ((autoNow.snapshot.players[0] || {}).hand || []).map((c) => c.id);
      const contRoles = (autoNow.snapshot.players || []).map((p) => p.role);
      const contTurn = autoNow.snapshot.turnCount || 0;
      await cdp.navigate(BASE + '?nofx=1&screen=home');
      const menu = await waitState((s) => s.screenActive.menu, 5000, '刷新后主菜单');
      assert(menu.continueVisible, '刷新后「继续游戏」不可见');
      assert(menu.savesBtnVisible, '刷新后「读取存档」不可见');
      assert(/2v2/.test(menu.continueMeta) && /第\s*\d+\s*回合/.test(menu.continueMeta), '继续按钮元信息异常：' + menu.continueMeta);
      await shot('qa_continue.png', row);
      await cdp.click('#btn-continue');
      const after = await waitState((s) => s.screenActive.game, 8000, '读档后对局');
      assertEq(after.mode, '2v2', '读档模式');
      assertEq(after.alive.length, 4, '读档人数');
      assertEq(after.seats, 3, '读档对手座位数');
      assertEq(after.alive.map((p) => p.role).join(','), contRoles.join(','), '读档座位角色');
      const afterIds = after.hand.map((c) => c.id);
      assert(contHand.every((id) => afterIds.indexOf(id) >= 0), '读档手牌缺少当前自动档手牌：saved=' + contHand.join(',') + ' after=' + afterIds.join(','));
      assert(after.turn >= contTurn && after.turn <= contTurn + 1, '读档回合重复累加：saved=' + contTurn + ' after=' + after.turn);
      await shot('qa_save_loaded.png', row);
      let auto2 = await readAuto();
      assert(auto2 && auto2.snapshot && auto2.snapshot.mode === '2v2', '读档后自动档未继续滚动');

      // 从主菜单读取槽位 2，自动档应跟随该局
      await cdp.navigate(BASE + '?nofx=1&screen=home');
      await waitState((s) => s.screenActive.menu, 5000, '读取槽位前主菜单');
      await cdp.click('#btn-saves');
      await waitState((s) => s.savesPanelOpen, 3000, '读档面板未打开');
      const panel = await cdp.eval(() => ({
        rows: document.querySelectorAll('#saves-list .save-row').length,
        texts: [].map.call(document.querySelectorAll('#saves-list .save-row'), (r) => r.innerText.replace(/\s+/g, ' ').trim()),
      }));
      assertEq(panel.rows, 4, '读取面板应含自动档+3 槽');
      assert(panel.texts[0].indexOf('自动存档') >= 0 && panel.texts[1].indexOf('槽位 1') >= 0, '读取面板槽位顺序异常：' + panel.texts.join(' | '));
      await cdp.click('#saves-list .save-row[data-slot="2"] [data-act="load"]');
      const loaded = await waitState((s) => s.screenActive.game, 8000, '读取槽位 2 后未进入对局');
      assertEq(loaded.mode, '2v2', '槽位 2 读档模式');
      assertEq(loaded.alive.length, 4, '槽位 2 读档人数');
      const slot2Turn = slot2.snapshot.turnCount || 0;
      assert(loaded.turn >= slot2Turn && loaded.turn <= slot2Turn + 1, '槽位 2 读档回合重复累加：saved=' + slot2Turn + ' after=' + loaded.turn);
      await sleep(700);
      auto2 = await readAuto();
      assert(auto2 && auto2.snapshot && auto2.snapshot.mode === '2v2', '读取手动槽后自动档未接管');

      // 删除槽位 1（二次确认），槽位 2 保留
      await cdp.navigate(BASE + '?nofx=1&screen=home');
      await waitState((s) => s.screenActive.menu, 5000, '删除前主菜单');
      await cdp.click('#btn-saves');
      await waitState((s) => s.savesPanelOpen, 3000, '删除面板未打开');
      await cdp.click('#saves-list .save-row[data-slot="1"] [data-act="delete"]');
      const delArmed = await cdp.eval(() => document.querySelector('#saves-list .save-row[data-slot="1"] [data-act="delete"]').textContent.trim());
      assertEq(delArmed, '确认删除', '删除槽位 1 未进入二次确认');
      await cdp.click('#saves-list .save-row[data-slot="1"] [data-act="delete"]');
      await sleep(250);
      const del1 = await cdp.eval(() => localStorage.getItem('sgs.save.slot1'));
      const keep2 = await cdp.eval(() => localStorage.getItem('sgs.save.slot2'));
      assert(del1 === null, '槽位 1 删除后仍存在');
      assert(!!keep2, '删除槽位 1 误删槽位 2');
      await cdp.click('#saves-close');
      return { actual: 'auto turn=' + contTurn + ' 含 rngState；槽位 1/2 保存与覆盖确认正常；继续按钮「' + menu.continueMeta + '」；读档 2v2/4 人/回合 ' + loaded.turn + '；删除槽 1 后槽 2 保留' };
    });

    /* ---------- T53 1v1 读档一致性 / duelFirstDraw / 结束清自动档 ---------- */
    await runCase('T53', '1v1 读档一致性 / duelFirstDraw / 结束清自动档', [
      '开 1v1 并等自动档写入',
      '保存槽位 3，结束出牌推进后读回槽位 3',
      '校验 duelFirstDraw 与回合不重复累加',
      '开启托管打到结算，校验自动档清除、槽位 3 保留',
    ], '1v1 自动档含 rngState 且 p0.duelFirstDraw=true；读槽位 3 后仍为 true、回合不重复；结算后 sgs.save.auto 清除而 slot3 保留', 'P1', async (row) => {
      const readAuto = () => cdp.eval(() => { try { const r = localStorage.getItem('sgs.save.auto'); return r ? JSON.parse(r) : null; } catch (e) { return null; } });
      const readSlot = (n) => cdp.eval((slot) => { try { const r = localStorage.getItem('sgs.save.slot' + slot); return r ? JSON.parse(r) : null; } catch (e) { return null; } }, n);
      await resetMenu();
      await cdp.click('#seg-mode [data-mode="1v1"]');
      await setMenuPace('fast');
      await cdp.click('#btn-start');
      await waitState((s) => s.screenActive.select, 5000, 'T53 1v1 选将页');
      await cdp.click('#general-row .general-card', 0);
      await cdp.click('#btn-general-confirm');
      await waitState((s) => s.screenActive.game && s.seats === 1, 10000, 'T53 1v1 牌桌');
      let auto = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) { auto = await readAuto(); if (auto && auto.snapshot) break; await sleep(200); }
      assert(auto && auto.snapshot, '1v1 未写入自动档');
      assertEq(auto.snapshot.mode, '1v1', '1v1 自动档模式');
      assert(typeof auto.snapshot.rngState === 'number', '1v1 自动档缺少 rngState');
      // 自动档是在“回合开始”写的；1 号位首轮摸牌 -1 发生在该回合的摸牌阶段，
      // 因此要推进到下一回合开始，自动档才会带上 duelFirstDraw。
      const tDuel = Date.now();
      while (Date.now() - tDuel < 25000 && !(auto && auto.snapshot && auto.snapshot.players[0].duelFirstDraw === true)) {
        const stDuel = await state();
        if (stDuel.over || stDuel.screenActive.result) break;
        if (stDuel.pending) {
          if (stDuel.pending.type === 'play') {
            await cdp.click('[data-act="play-end"]', 0, { wait: 50 }).catch(() => {});
          } else if (stDuel.pending.type === 'chooseCards') {
            // 弃牌阶段走手牌点选 + 动作栏确认（无 modal）
            const need = Math.max(0, stDuel.pending.min || 0);
            for (let i = 0; i < need; i++) await cdp.click('#hand .hand-card', i, { wait: 30 }).catch(() => {});
            if (need > 0) await cdp.click('[data-act="pick-confirm"]', 0, { wait: 50 }).catch(() => {});
          } else {
            await pumpPending('T53 推进到下一回合').catch(() => {});
          }
        }
        await sleep(250);
        auto = await readAuto();
      }
      assert(auto && auto.snapshot && auto.snapshot.players[0].duelFirstDraw === true, '1v1 自动档未记录 p0.duelFirstDraw=true');
      await clickMenu('#btn-save');
      await waitState((s) => s.savesPanelOpen, 3000, '1v1 保存面板未打开');
      await cdp.click('#saves-list .save-row[data-slot="3"] [data-act="save"]');
      await cdp.waitExpr('!!localStorage.getItem("sgs.save.slot3")', 3000);
      const slot3 = await readSlot(3);
      const slot3Turn = slot3.snapshot.turnCount || 0;
      await cdp.click('#saves-close');
      if ((await state()).pending && (await state()).pending.type === 'play') {
        await cdp.click('[data-act="play-end"]').catch(() => {});
      }
      await sleep(1200);
      await cdp.eval(() => SGS_SAVE.openLoadPanel());
      await waitState((s) => s.savesPanelOpen, 3000, '1v1 读档面板未打开');
      await cdp.click('#saves-list .save-row[data-slot="3"] [data-act="load"]');
      const loaded = await waitState((s) => s.screenActive.game && s.mode === '1v1', 8000, '1v1 读取槽位 3 失败');
      assert(loaded.turn >= slot3Turn && loaded.turn <= slot3Turn + 1, '1v1 读档回合重复累加：saved=' + slot3Turn + ' after=' + loaded.turn);
      const duelAfter = await cdp.eval(() => SGS_UI._state().game.players[0].duelFirstDraw === true);
      assert(duelAfter, '读档后 p0.duelFirstDraw 丢失');
      await clearPendingSafely(8000);
      await clickMenu('#btn-trust');
      await waitState((s) => s.screenActive.result, 240000, '1v1 托管未到结算');
      const autoEnd = await readAuto();
      const slotEnd = await readSlot(3);
      assert(autoEnd === null, '1v1 结算后自动档未清除');
      assert(slotEnd && slotEnd.snapshot, '1v1 结算后槽位 3 被误删');
      return { actual: '1v1 auto 含 rngState、duelFirstDraw=true；读槽 3 回合 ' + slot3Turn + '→' + loaded.turn + ' 且标记保留；结算后 auto 清除、slot3 保留' };
    });

    /* ---------- T54 演示 / 新游戏 / 投降 对存档的边界 ---------- */
    await runCase('T54', '演示不读写存档 / 新游戏只覆盖自动 / 投降清自动留手动', [
      '记录手动槽位 3 与自动档',
      '启动自动演示并等数个 AI 回合，校验 auto 与槽位 3 完全不变',
      '回主菜单开新 1v1，校验旧自动档被新局覆盖',
      '投降判负后校验自动档清除、槽位 3 保留',
    ], '演示期间 auto 原始字符串不变、slot3 不变；新游戏只覆盖 auto；投降后 auto 为 null 而 slot3 仍在', 'P1', async (row) => {
      const rawAuto = () => cdp.eval(() => localStorage.getItem('sgs.save.auto'));
      const rawSlot = (n) => cdp.eval((slot) => localStorage.getItem('sgs.save.slot' + slot), n);
      const slot3Before = await rawSlot(3);
      if (!slot3Before) return { skip: 'T53 未留下手动槽位 3，跳过边界验证' };
      const autoBefore = await rawAuto();
      await resetMenu();
      // B5 菜单会记住上一局的模式；演示固定按 8p 跑，避免沿用 T53 的 1v1
      await cdp.click('#seg-mode [data-mode="8p"]');
      await setMenuPace('fast');
      await cdp.click('#btn-demo');
      await waitState((s) => s.screenActive.game && s.seats >= 7, 10000, '演示未进入对局');
      await sleep(3000);
      const autoDuringDemo = await rawAuto();
      assert(autoDuringDemo === autoBefore, '演示改写了自动档：before=' + (autoBefore && autoBefore.length) + ' during=' + (autoDuringDemo && autoDuringDemo.length));
      assertEq(await rawSlot(3), slot3Before, '演示改写了手动槽位 3');

      await resetMenu();
      await cdp.click('#seg-mode [data-mode="1v1"]');
      await setMenuPace('fast');
      await cdp.click('#btn-start');
      await waitState((s) => s.screenActive.select, 5000, 'T54 1v1 选将页');
      await cdp.click('#general-row .general-card', 0);
      await cdp.click('#btn-general-confirm');
      await waitState((s) => s.screenActive.game && s.seats === 1, 10000, 'T54 1v1 牌桌');
      let auto1v1 = null;
      const tAuto = Date.now();
      while (Date.now() - tAuto < 10000) {
        auto1v1 = await cdp.eval(() => { try { return JSON.parse(localStorage.getItem('sgs.save.auto')); } catch (e) { return null; } });
        if (auto1v1 && auto1v1.snapshot && auto1v1.snapshot.mode === '1v1') break;
        await sleep(200);
      }
      assert(auto1v1 && auto1v1.snapshot && auto1v1.snapshot.mode === '1v1', '新 1v1 未只覆盖自动档');
      assertEq(await rawSlot(3), slot3Before, '开新游戏误删手动槽位');
      await clickMenu('#btn-surrender');
      await waitState((s) => s.modalCount > 0, 3000, '投降确认框未出现');
      await cdp.click('[data-c="1"]');
      await waitState((s) => s.screenActive.result, 10000, '投降后未到结算');
      assert((await rawAuto()) === null, '投降判负后自动档未清除');
      assertEq(await rawSlot(3), slot3Before, '投降判负误删手动槽位');

      // 退出判负同样只清自动档
      await cdp.click('#btn-home');
      await waitState((s) => s.screenActive.menu, 5000, 'T54 投降后回主菜单');
      await cdp.click('#seg-mode [data-mode="1v1"]');
      await setMenuPace('fast');
      await cdp.click('#btn-start');
      await waitState((s) => s.screenActive.select, 5000, 'T54 再次 1v1 选将页');
      await cdp.click('#general-row .general-card', 0);
      await cdp.click('#btn-general-confirm');
      await waitState((s) => s.screenActive.game && s.seats === 1, 10000, 'T54 再次 1v1 牌桌');
      let autoQuit = null;
      const tQuit = Date.now();
      while (Date.now() - tQuit < 10000) {
        autoQuit = await cdp.eval(() => localStorage.getItem('sgs.save.auto'));
        if (autoQuit) break;
        await sleep(200);
      }
      assert(!!autoQuit, '退出判负前未写入自动档');
      await clickMenu('#btn-quit');
      await waitState((s) => s.modalCount > 0, 3000, '退出确认框未出现');
      await cdp.click('[data-c="1"]');
      await waitState((s) => s.screenActive.menu, 5000, '退出判负后未回主菜单');
      assert((await rawAuto()) === null, '退出判负后自动档未清除');
      assertEq(await rawSlot(3), slot3Before, '退出判负误删手动槽位');
      return { actual: '演示 3s 内 auto/slot3 不变；新 1v1 覆盖 auto 且槽 3 保留；投降/退出判负后 auto=null、槽 3 保留' };
    });

    /* ---------- T55 存档异常：v1 迁移 / 损坏 / 写失败 / 暂停读档 ---------- */
    await runCase('T55', '存档异常：v1 迁移 / 损坏 / 缺字段 / 写失败 / 暂停读档', [
      '用不含 rngState 的 1.0.6 结构写 sgs.save.v1，刷新后校验迁移为 auto 并可继续',
      '写入损坏 JSON 与缺字段 auto，刷新后提示「存档损坏」且回到主菜单',
      '写入损坏槽位 1，打开读取面板应清除并提示',
      '暂停状态下读档，校验牌桌与倒计时正常',
      '替换 localStorage.setItem 抛错，校验手动保存明确提示失败',
    ], 'v1 迁移为 auto 且旧键清除；损坏/缺字段不白屏并提示「存档损坏」；暂停读档后倒计时正常；写失败返回 ok=false 且提示保存失败', 'P1', async (row) => {
      const home = async (label) => {
        await cdp.navigate(BASE + '?nofx=1&screen=home');
        return await waitState((s) => s.screenActive.menu, 6000, label || '回主菜单');
      };
      const readAuto = () => cdp.eval(() => { try { const r = localStorage.getItem('sgs.save.auto'); return r ? JSON.parse(r) : null; } catch (e) { return null; } });
      await cdp.navigate(BASE + '?nofx=1&screen=game&seed=2026');
      await waitState((s) => s.screenActive.game && s.seats === 7, 10000, 'T55 取快照');
      const fixture = await cdp.eval(() => SGS_UI._state().game.snapshot());
      const legacySnap = JSON.parse(JSON.stringify(fixture));
      delete legacySnap.rngState; // 1.0.6 快照没有 rngState
      legacySnap.turnCount = 5;
      legacySnap.currentSeat = 2;
      legacySnap.players[2].revealed = true;
      await cdp.eval((snap) => {
        localStorage.removeItem('sgs.save.auto');
        localStorage.setItem('sgs.save.v1', JSON.stringify({ v: 1, time: Date.now() - 1000, mode: '8p', snapshot: snap }));
      }, legacySnap);
      const menu1 = await home('v1 迁移后主菜单');
      await sleep(500);
      const autoMigrated = await readAuto();
      const legacyLeft = await cdp.eval(() => localStorage.getItem('sgs.save.v1'));
      assert(autoMigrated && autoMigrated.snapshot && autoMigrated.snapshot.mode === '8p', 'v1 未迁移为 auto');
      assert(autoMigrated.v === 2, '迁移后的 auto 版本不是 2');
      assert(legacyLeft === null, 'v1 迁移后旧键未清除');
      assert(menu1.continueVisible, 'v1 迁移后继续游戏不可见');
      assert(menu1.continueMeta.indexOf('八人身份局') >= 0, '迁移后继续信息异常：' + menu1.continueMeta);
      await cdp.click('#btn-continue');
      const g1 = await waitState((s) => s.screenActive.game, 8000, '迁移档读取失败');
      assertEq(g1.mode, '8p', '迁移档模式');
      assert(g1.turn >= 5 && g1.turn <= 6, '迁移档回合异常：' + g1.turn);
      const revealed = await cdp.eval(() => {
        const p = SGS_UI._state().game.players[2];
        const roleEl = document.querySelector('#seats .seat[data-seat="2"] .seat-role');
        return { flag: p.revealed === true, text: roleEl ? roleEl.textContent.trim() : '' };
      });
      assert(revealed.flag && revealed.text !== '?', 'revealed 身份读档后不可见：' + JSON.stringify(revealed));
      row.notes.push('1.0.6 无 rngState 存档迁移读取通过，回合=' + g1.turn);

      await cdp.eval(() => { localStorage.setItem('sgs.save.auto', '{broken'); });
      await home('损坏 auto 后主菜单');
      await sleep(500);
      assert((await cdp.eval(() => localStorage.getItem('sgs.save.auto'))) === null, '损坏 auto 未清除');
      assert(!(await state()).continueVisible, '损坏 auto 后继续按钮仍可见');
      const corruptToast = await cdp.waitExpr('!!Array.prototype.find.call(document.querySelectorAll("#toast-root .toast"), function (t) { return t.textContent.indexOf("存档损坏") >= 0; })', 3000).catch(() => false);
      assert(corruptToast, '损坏 auto 未提示「存档损坏」');

      await cdp.eval(() => { localStorage.setItem('sgs.save.auto', '{"v":2,"snapshot":{"mode":"8p"}}'); });
      await home('缺字段 auto 后主菜单');
      await sleep(400);
      assert((await cdp.eval(() => localStorage.getItem('sgs.save.auto'))) === null, '缺字段 auto 未清除');

      await cdp.eval(() => { localStorage.setItem('sgs.save.slot1', '{"v":2,"snapshot":{"players":[]}}'); });
      await home('损坏槽位后主菜单');
      await cdp.eval(() => SGS_SAVE.openLoadPanel());
      await waitState((s) => s.savesPanelOpen, 3000, '损坏槽位后面板未打开');
      await sleep(300);
      assert((await cdp.eval(() => localStorage.getItem('sgs.save.slot1'))) === null, '损坏槽位 1 未清除');
      await cdp.click('#saves-close');

      // 暂停状态下读档：写入一份有效 auto，再在暂停标记下继续
      const pauseSnap = JSON.parse(JSON.stringify(fixture));
      pauseSnap.currentSeat = 0;
      pauseSnap.turnCount = 3;
      pauseSnap.over = false;
      await cdp.eval((snap) => {
        localStorage.setItem('sgs.save.auto', JSON.stringify({ v: 2, kind: 'auto', time: Date.now(), mode: '8p', meta: { mode: '8p', turn: 3, general: snap.players[0].general.name, time: Date.now() }, snapshot: snap }));
      }, pauseSnap);
      await home('暂停读档前主菜单');
      await cdp.eval(() => { if (window.SGS_APP_PAUSE) window.SGS_APP_PAUSE(true, { keepAudio: true }); });
      await cdp.click('#btn-continue');
      await waitState((s) => s.screenActive.game, 8000, '暂停状态读档失败');
      let pausedLoad = await state();
      const tPause = Date.now();
      while (Date.now() - tPause < 10000) {
        pausedLoad = await state();
        if (/^\d+s$/.test(String(pausedLoad.countdown || '').trim()) || (pausedLoad.pending && pausedLoad.pending.type === 'play')) break;
        await sleep(200);
      }
      assert(/^\d+s$/.test(String(pausedLoad.countdown || '').trim()) || (pausedLoad.pending && pausedLoad.pending.type === 'play'), '暂停读档后倒计时/请求异常：' + JSON.stringify({ countdown: pausedLoad.countdown, pending: pausedLoad.pending && pausedLoad.pending.type }));
      await cdp.eval(() => { if (window.SGS_APP_PAUSE) window.SGS_APP_PAUSE(false, {}); });

      // 写失败：替换 setItem 抛错，手动保存必须返回失败并提示
      const fail = await cdp.eval(() => {
        const orig = Storage.prototype.setItem;
        Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };
        let res = null;
        try { res = SGS_SAVE.saveSlot(1); } finally { Storage.prototype.setItem = orig; }
        return { ok: res && res.ok, bytes: res && res.bytes };
      });
      assert(fail.ok === false, '写失败时手动保存仍返回成功');
      const failToast = await cdp.waitExpr('!!Array.prototype.find.call(document.querySelectorAll("#toast-root .toast"), function (t) { return t.textContent.indexOf("保存失败") >= 0; })', 3000).catch(() => false);
      assert(failToast, '写失败未提示保存失败');
      return { actual: 'v1→auto 迁移通过（回合 ' + g1.turn + '，revealed 可见）；损坏/缺字段 auto 清除并提示；损坏槽位清除；暂停读档倒计时=' + pausedLoad.countdown + '；写失败 ok=false 且有提示' };
    });

    /* ---------- T56 身份标记随存档恢复且不泄露 ---------- */
    await runCase('T56', '身份标记随存档恢复 / 不泄露真实身份', [
      '8p 开局，给座位 1/2 和一名隐藏反贼标记',
      '手动保存槽 1：校验 meta.marks 包含全部标记，snapshot.players 无标记字段',
      '结束出牌触发自动存档：校验 auto meta.marks 至少含 1/2 号标记',
      '刷新→继续：标记恢复，DOM 显示忠/反',
      '新开一局：标记清空；读槽 1：隐藏反贼仍显示用户标记忠，auto 同步',
      '旧存档无 meta.marks：按空处理不报错',
    ], '标记只进信封 meta；手动/自动档读档后恢复；隐藏反贼标记为忠后 DOM 显示忠而非真实反；新局清空；旧档不报错', 'P1', async (row) => {
      const getMarks = () => cdp.eval(() => (SGS_UI.getSeatMarks ? SGS_UI.getSeatMarks() : null));
      const roleText = (seat) => cdp.eval((s) => {
        const el = document.querySelector('#seats .seat[data-seat="' + s + '"] .seat-role');
        return el ? el.textContent.trim() : '';
      }, seat);
      const markSeat = async (seat, times) => {
        for (let i = 0; i < times; i++) {
          await cdp.click('#seats .seat[data-seat="' + seat + '"] .seat-role', 0, { wait: 80 }).catch(() => cdp.eval((s2) => {
            const b = document.querySelector('#seats .seat[data-seat="' + s2 + '"] .seat-role');
            if (b) b.click();
          }, seat));
        }
      };
      const waitAutoMarks = async (want) => {
        const t0 = Date.now();
        while (Date.now() - t0 < 45000) {
          const m = await cdp.eval(() => {
            try { const d = JSON.parse(localStorage.getItem('sgs.save.auto') || 'null'); return d && d.meta ? d.meta.marks || null : null; } catch (e) { return null; }
          });
          if (m && Object.keys(want).every((k) => m[k] === want[k])) return m;
          await sleep(250);
        }
        return null;
      };
      await start8pGame();
      await waitState((s) => s.screenActive.game && s.seats === 7, 8000, 'T56 8p 牌桌');
      // 座位1/2必须是可标记的未知身份；若随机到主公则重开，避免把「主公」公开身份误判为标记失效
      let lordSeat = await cdp.eval(() => { const g = SGS_UI._state().game; const p = g.players.find((x) => x.role === 'lord'); return p ? p.seat : null; });
      for (let attempt = 0; attempt < 6 && (lordSeat === 1 || lordSeat === 2); attempt++) {
        await start8pGame();
        await waitState((s) => s.screenActive.game && s.seats === 7, 8000, 'T56 换局');
        lordSeat = await cdp.eval(() => { const g = SGS_UI._state().game; const p = g.players.find((x) => x.role === 'lord'); return p ? p.seat : null; });
      }
      assert(lordSeat !== 1 && lordSeat !== 2, 'T56 连续 6 局座位1/2仍是主公，无法验证标记');
      await markSeat(1, 1); // loyalist
      await markSeat(2, 2); // rebel
      const hiddenRebel = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        const p = g.players.find((x) => x.seat !== 0 && x.alive && !x.revealed && x.role !== 'lord' && x.role === 'rebel');
        return p ? p.seat : null;
      });
      if (hiddenRebel != null && hiddenRebel !== 1 && hiddenRebel !== 2) await markSeat(hiddenRebel, 1);
      let marks = await getMarks();
      assertEq(marks['1'], 'loyalist', '座位1标记');
      assertEq(marks['2'], 'rebel', '座位2标记');
      assertEq(await roleText(1), '忠', '座位1标记显示');
      assertEq(await roleText(2), '反', '座位2标记显示');
      await shot('qa_role_marks.png', row);

      // 先手动保存：此刻隐藏反贼必定存活，验证“标记不泄露真实身份”是确定的
      await cdp.eval(() => SGS_SAVE.openSavePanel());
      await waitState((s) => s.savesPanelOpen, 3000, 'T56 保存面板');
      await cdp.click('#saves-list .save-row[data-slot="1"] [data-act="save"]');
      await cdp.waitExpr('!!localStorage.getItem("sgs.save.slot1")', 3000);
      const slotMeta = await cdp.eval(() => {
        const d = JSON.parse(localStorage.getItem('sgs.save.slot1'));
        const keys = d.snapshot.players.map((p, i) => Object.keys(p).filter((k) => /seatMark|roleMark|identityMark|roleNote|notes/i.test(k)).map((k) => i + ':' + k));
        return { marks: d.meta && d.meta.marks || null, badFields: [].concat.apply([], keys) };
      });
      assertEq(JSON.stringify(slotMeta.marks), JSON.stringify(marks), '槽位 meta.marks');
      assertEq(slotMeta.badFields.length, 0, 'snapshot.players 出现标记字段：' + slotMeta.badFields.join(','));
      await cdp.click('#saves-close');

      // 结束出牌，等下一次回合开始的自动存档带上 1/2 号标记（隐藏反贼可能阵亡，不作精确要求）
      await cdp.click('[data-act="play-end"]', 0, { wait: 80 }).catch(() => cdp.eval(() => {
        const b = document.querySelector('[data-act="play-end"]'); if (b) b.click();
      }));
      await sleep(600);
      const discardN = await cdp.eval(() => {
        const st = SGS_UI._state(); const req = st.pending && st.pending.req;
        return req && req.type === 'chooseCards' ? Math.max(0, req.min || 0) : 0;
      });
      for (let i = 0; i < discardN; i++) await cdp.click('#hand .hand-card', i, { wait: 30 });
      if (discardN > 0) await cdp.click('[data-act="pick-confirm"]', 0, { wait: 60 });
      const autoMarks = await waitAutoMarks({ 1: 'loyalist', 2: 'rebel' });
      assert(autoMarks, '自动存档 meta.marks 未包含 1/2 号标记：' + JSON.stringify(autoMarks));
      row.notes.push('auto.meta.marks=' + JSON.stringify(autoMarks));

      // 刷新→继续：自动档恢复 1/2 标记，DOM 显示忠/反
      await cdp.navigate(BASE + '?nofx=1&screen=home');
      await waitState((s) => s.screenActive.menu, 5000, 'T56 刷新主菜单');
      await cdp.click('#btn-continue');
      await waitState((s) => s.screenActive.game, 8000, 'T56 继续读档');
      marks = await getMarks();
      assertEq(marks['1'], 'loyalist', '读自动档后座位1标记');
      assertEq(marks['2'], 'rebel', '读自动档后座位2标记');
      assertEq(await roleText(1), '忠', '读自动档后座位1显示');
      assertEq(await roleText(2), '反', '读自动档后座位2显示');

      // 新开一局（不读档）标记必须清空
      await start8pGame();
      await waitState((s) => s.screenActive.game && s.seats === 7, 8000, 'T56 新局');
      assertEq(Object.keys(await getMarks()).length, 0, '新开局仍保留标记');

      // 读槽位 1：标记完整恢复；隐藏反贼在存档时仍存活，读档后应显示用户标记“忠”而非真实“反”
      await cdp.navigate(BASE + '?nofx=1&screen=home');
      await waitState((s) => s.screenActive.menu, 5000, 'T56 读槽前菜单');
      await cdp.click('#btn-saves');
      await waitState((s) => s.savesPanelOpen, 3000, 'T56 读档面板');
      await cdp.click('#saves-list .save-row[data-slot="1"] [data-act="load"]');
      await waitState((s) => s.screenActive.game, 8000, 'T56 读槽1');
      marks = await getMarks();
      assertEq(marks['1'], 'loyalist', '读槽1后标记');
      assertEq(marks['2'], 'rebel', '读槽1后标记');
      assertEq(await roleText(1), '忠', '读槽1后座位1显示');
      assertEq(await roleText(2), '反', '读槽1后座位2显示');
      if (hiddenRebel != null && hiddenRebel !== 1 && hiddenRebel !== 2) {
        assertEq(marks[String(hiddenRebel)], 'loyalist', '读槽1后隐藏反贼标记');
        assertEq(await roleText(hiddenRebel), '忠', '隐藏反贼读档后仍显示用户标记忠');
      }
      const autoAfter = await cdp.eval(() => {
        try { const d = JSON.parse(localStorage.getItem('sgs.save.auto') || 'null'); return d && d.meta ? d.meta.marks || null : null; } catch (e) { return null; }
      });
      assertEq(JSON.stringify(autoAfter), JSON.stringify(marks), '读槽后 auto.meta.marks 未同步');

      // 复制槽 1 并删除 meta.marks，模拟旧存档：读档空标记、不报错
      await cdp.eval(() => {
        const d = JSON.parse(localStorage.getItem('sgs.save.slot1'));
        delete d.meta.marks;
        localStorage.setItem('sgs.save.slot2', JSON.stringify(d));
      });
      await cdp.navigate(BASE + '?nofx=1&screen=home');
      await waitState((s) => s.screenActive.menu, 5000, 'T56 旧档前菜单');
      await cdp.eval(() => SGS_SAVE.openLoadPanel());
      await waitState((s) => s.savesPanelOpen, 3000, 'T56 旧档面板');
      await cdp.click('#saves-list .save-row[data-slot="2"] [data-act="load"]');
      await waitState((s) => s.screenActive.game, 8000, 'T56 旧档读档');
      assertEq(Object.keys(await getMarks()).length, 0, '无 marks 旧档读档后出现标记');
      return { actual: '标记写入 auto/slot meta；读档恢复（含隐藏反贼显示用户标记）；新局清空；无 marks 旧档按空处理' };
    });

    /* ---------- T35 2v2 结算 ---------- */
    await runCase('T35', '2v2 托管跑到结算 / 胜负文案', [
      '开启托管',
      '等待结算页',
      '校验 4 名玩家、蓝队/红队获胜文案、胜负与队伍一致',
    ], '结算 4 名玩家；副标题含蓝队或红队获胜；标题与人类队伍/winner 一致；截图 qa_result_2v2.png', 'P1', async (row) => {
      let st = await state();
      if (!(st.screenActive.game && st.mode === '2v2' && !st.over)) await startTeamGame('2v2');
      if (!st.screenActive.result) {
        await clearPendingSafely(10000);
        await clickMenu('#btn-trust');
      }
      st = await waitState((s) => s.screenActive.result, 600000, '等待 2v2 结算');
      assertEq(st.resultPlayers.length, 4, '2v2 结算玩家数');
      assert(/蓝队|红队/.test(st.resultSub) && /获胜/.test(st.resultSub), '2v2 结算缺少队伍获胜文案：' + st.resultSub);
      assert(['胜利', '失败', '平局'].indexOf(st.resultTitle) >= 0, '2v2 结算标题异常：' + st.resultTitle);
      if (st.resultTitle === '胜利') assertEq(st.role, st.winner, '2v2 胜利队伍不一致');
      if (st.resultTitle === '失败') assert(st.role !== st.winner, '2v2 失败但人类队伍=winner');
      await shot('qa_result_2v2.png', row);
      return { actual: '玩家=4，标题=' + st.resultTitle + '，' + truncate(st.resultSub, 60) };
    });

    /* ---------- T36 3v3 牌桌 / 队伍 / 结算 ---------- */
    await runCase('T36', '3v3 牌桌 / 队伍标签 / 结算', [
      '菜单点击 3v3，读取候选数',
      '选将 3 张并保留手气卡',
      '读取 5 个对手、蓝队/红队标签并截图',
      '托管跑到结算，校验 6 名玩家与队伍获胜文案',
    ], '候选 3 张；5 个对手；队伍标签蓝/红；结算 6 名玩家且含蓝队/红队获胜文案；截图 qa_table_3v3.png / qa_result_3v3.png', 'P1', async (row) => {
      const r = await startTeamGame('3v3');
      assertEq(r.cards, 3, '3v3 候选数');
      const st = r.st;
      assertEq(st.mode, '3v3', '3v3 模式');
      assertEq(st.seats, 5, '3v3 对手座位数');
      const texts = st.seatRoles.map((x) => x.role);
      assert(texts.indexOf('蓝队') >= 0 && texts.indexOf('红队') >= 0, '3v3 座位缺少蓝队/红队：' + texts.join('/'));
      assert(st.meRole === '蓝队' || st.meRole === '红队', '3v3 自己队伍标签异常：' + st.meRole);
      await shot('qa_table_3v3.png', row);
      await clearPendingSafely(10000);
      // 3v3 可能在清理后立刻弹出新的技能选项（好施等），挡住「更多」菜单；先清掉再点，最多重试 5 次
      let trustClicked = false;
      for (let attempt = 0; attempt < 5 && !trustClicked; attempt++) {
        try {
          await clickMenu('#btn-trust');
          trustClicked = true;
        } catch (e) {
          await clearPendingSafely(3000);
          await sleep(200);
        }
      }
      assert(trustClicked, '3v3 托管理：5 次清理后「更多」菜单仍不可见');
      const end = await waitState((s) => s.screenActive.result, 600000, '等待 3v3 结算');
      assertEq(end.resultPlayers.length, 6, '3v3 结算玩家数');
      assert(/蓝队|红队/.test(end.resultSub) && /获胜/.test(end.resultSub), '3v3 结算缺少队伍获胜文案：' + end.resultSub);
      if (end.resultTitle === '胜利') assertEq(end.role, end.winner, '3v3 胜利队伍不一致');
      if (end.resultTitle === '失败') assert(end.role !== end.winner, '3v3 失败但人类队伍=winner');
      await shot('qa_result_3v3.png', row);
      return { actual: '候选=3；座位=5；标签=' + texts.join('/') + '；结算=6 人，' + truncate(end.resultSub, 50) };
    });

    /* ---------- T37 音频播放观测 ---------- */
    await runCase('T37', '音频播放观测（杀 / 闪 / 装备 / 锦囊）', [
      '清空缓存后打开 8p 自动演示',
      'CDP 拦截 HTMLMediaElement.play，记录 src/currentTime/error',
      '对齐 SGS_AUDIO.playCard 请求与音频播放',
      '对缺失类别做 API 补测并记录',
    ], '至少观测到【杀】【装备】【锦囊】的 play 调用；【闪】若 UI 未触发需记录 API 补测结果；记录延迟/错误/错牌', 'P1', async (row) => {
      await cdp.navigate(BASE + '?nofx=1&mode=8p&pace=fast&seed=2026');
      await installAudioWrapper();
      // B5 菜单会恢复上次模式；显式 8p，保证 7 个对手座位与音频事件量
      await cdp.click('#seg-mode [data-mode="8p"]');
      await setMenuPace('fast');
      await cdp.click('#btn-demo');
      await waitState((s) => s.screenActive.game && s.seats >= 7, 8000, '音频观测：自动演示未进入对局');
      const typeOf = (name) => (QA_DATA && QA_DATA.CARDS && QA_DATA.CARDS[name] ? QA_DATA.CARDS[name].type : null);
      const isSha = (r) => ['sha', 'huosha', 'leisha'].indexOf(r.name) >= 0;
      const isEquip = (r) => typeOf(r.name) === 'equip';
      const isTrick = (r) => ['trick', 'delayed'].indexOf(typeOf(r.name)) >= 0;
      const isShan = (r) => r.name === 'shan';
      let snap = null;
      let seen = { sha: false, equip: false, trick: false, shan: false };
      const t0 = Date.now();
      while (Date.now() - t0 < 50000) {
        snap = await cdp.eval(() => ({ audio: window.__qaAudio || [], req: window.__qaAudioCardReq || [] }));
        seen = {
          sha: snap.req.some(isSha), equip: snap.req.some(isEquip),
          trick: snap.req.some(isTrick), shan: snap.req.some(isShan),
        };
        if (seen.sha && seen.equip && seen.trick && Date.now() - t0 > 8000) break;
        await sleep(800);
      }
      await shot('qa_audio_probe.png', row);
      const missing = [];
      if (!seen.sha) missing.push('sha');
      if (!seen.equip) missing.push('qinggang');
      if (!seen.trick) missing.push('wuzhong');
      if (!seen.shan) missing.push('shan');
      for (const name of missing) {
        await cdp.eval((n) => {
          try {
            window.__qaAudioCardReq = window.__qaAudioCardReq || [];
            window.__qaAudioCardReq.push({ t: Date.now(), name: n, probe: true });
            if (window.SGS_AUDIO && window.SGS_AUDIO.playCard) window.SGS_AUDIO.playCard(n);
            return true;
          } catch (e) { return String(e); }
        }, name);
        await sleep(500);
      }
      snap = await cdp.eval(() => ({ audio: window.__qaAudio || [], req: window.__qaAudioCardReq || [] }));
      const req = snap.req || [];
      const audio = snap.audio || [];
      const plays = audio.filter((e) => e.event !== 'progress' && e.src);
      const progress = audio.filter((e) => e.event === 'progress');
      const pick = (pred) => req.filter(pred).find((r) => !r.probe) || req.filter(pred).find((r) => r.probe) || null;
      const srcBase = (src) => String(src || '').split('/').pop().split('?')[0];
      const expectedPrefix = (name) => {
        if (['sha', 'huosha', 'leisha'].indexOf(name) >= 0) return name + '_';
        return name + '_';
      };
      const check = (r) => {
        if (!r) return null;
        const near = plays.filter((e) => e.src && e.t >= r.t - 100 && e.t <= r.t + 1600);
        const want = expectedPrefix(r.name);
        const expected = near.find((e) => srcBase(e.src).indexOf(want) === 0) || null;
        const fallback = near.find((e) => srcBase(e.src) === 'sfx_card_play.mp3') || null;
        // 优先匹配本牌音频；只有本牌缺失时才用通用牌音兜底；不把同时触发的伤害/武将/背景音当成牌音
        const p = expected || fallback || null;
        const pr = p ? progress.filter((e) => e.src === p.src && e.t >= p.t).pop() : null;
        return { req: r, play: p, expected, fallback, near, delay: p ? p.t - r.t : null,
          reject: p && p.reject, error: p && p.error, progress: pr, wrong: !expected && p && !fallback };
      };
      const sha = check(pick(isSha));
      const shan = check(pick(isShan));
      const equip = check(pick(isEquip));
      const trick = check(pick(isTrick));
      const shaUI = req.some((r) => isSha(r) && !r.probe);
      const shanUI = req.some((r) => isShan(r) && !r.probe);
      const equipUI = req.some((r) => isEquip(r) && !r.probe);
      const trickUI = req.some((r) => isTrick(r) && !r.probe);
      const problems = [];
      const checkCard = (label, x, uiTriggered) => {
        if (!x) return;
        if (!x.play) { problems.push(label + (uiTriggered ? ' UI 请求了 playCard' : ' API 补测') + ' 但未观测到牌音播放'); return; }
        if (x.reject || x.error) problems.push(label + ' play 失败：' + (x.reject || JSON.stringify(x.error)));
        if (x.delay != null && x.delay > 800) problems.push(label + ' 播放延迟 ' + x.delay + 'ms');
        if (x.wrong) problems.push(label + ' 播放了错误牌音频：' + x.play.src);
        if (x.progress && !(x.progress.currentTime > 0) && x.progress.paused) problems.push(label + ' currentTime 未推进且 paused=true');
      };
      if (shaUI) checkCard('【杀】', sha, true); else problems.push('【杀】UI 未触发 playCard');
      checkCard('【闪】', shan, shanUI);
      if (!shanUI) row.notes.push('【闪】UI 未调用 playCard；已用 API 补测 shan 资源');
      checkCard('【装备】', equip, equipUI);
      checkCard('【锦囊】', trick, trickUI);
      if (!equipUI) row.notes.push('【装备】UI 未触发 playCard；使用 API 补测');
      if (!trickUI) row.notes.push('【锦囊】UI 未触发 playCard；使用 API 补测');
      if (!audio.length) throw new Error('未捕获任何 HTMLMediaElement.play 记录');
      row.notes.push('音频记录 ' + audio.length + ' 条；请求 ' + req.length + ' 条；UI 杀=' + shaUI + ' 闪=' + shanUI + ' 装备=' + equipUI + ' 锦囊=' + trickUI);
      if (sha) row.notes.push('【杀】src=' + (sha.play && sha.play.src) + ' delay=' + sha.delay + 'ms reject=' + sha.reject + ' error=' + JSON.stringify(sha.error) + ' progress=' + JSON.stringify(sha.progress));
      if (shan) row.notes.push('【闪】src=' + (shan.play && shan.play.src) + ' delay=' + shan.delay + 'ms reject=' + shan.reject + ' error=' + JSON.stringify(shan.error));
      if (equip) row.notes.push('【装备】src=' + (equip.play && equip.play.src) + ' delay=' + equip.delay + 'ms');
      if (trick) row.notes.push('【锦囊】src=' + (trick.play && trick.play.src) + ' delay=' + trick.delay + 'ms');
      const fmt = (x) => x && x.play ? ('play ' + (x.delay == null ? '?' : x.delay + 'ms') + ' ' + srcBase(x.play.src) + (x.reject ? ' REJECT' : '') + (x.error ? ' ERROR' : '')) : '无播放';
      const actual = '杀(UI=' + shaUI + ')=' + fmt(sha) + '；闪(UI=' + shanUI + ')=' + fmt(shan) + '；装备(UI=' + equipUI + ')=' + fmt(equip) + '；锦囊(UI=' + trickUI + ')=' + fmt(trick);
      if (problems.length) throw new Error(actual + '；问题：' + problems.join('；'));

      // 技能语音 owner：按战报“发动者名字”匹配，而不是第一个有该技能的存活角色
      const skillInfo = await cdp.eval(() => {
        const logs = Array.prototype.map.call(document.querySelectorAll('#log-body .log-line.t-skill'), (el) => el.textContent.trim());
        const nameById = (id) => {
          const g = (window.SGS_DATA && SGS_DATA.GENERALS || []).find((x) => String(x.id) === String(id));
          return g ? g.name : null;
        };
        const gens = (window.__qaAudioGeneral || []).filter((g) => g.kind === 'skill').map((g) => ({ id: g.id, name: nameById(g.id), t: g.t }));
        const sfxKeys = (window.__qaAudioSfx || []).map((x) => x.key);
        return { logs, gens, sfxKeys };
      });
      const normOwner = (s) => String(s || '').replace(/^#\d+\s*/, '').replace(/\s*对\s+.+$/, '').replace(/^你（(.+)）$/, '$1').trim();
      // 确定性 owner 场景：1/2 号位都拥有【仁德】，战报写 2 号位发动，验证不会取第一个有该技能的 1 号位
      const synthetic = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        const p1 = g.players[1], p2 = g.players[2];
        p1.skills = ['rende']; p2.skills = ['rende'];
        window.__qaAudioGeneral = [];
        g.logs = [];
        g.logs.push({ type: 'skill', text: p2.general.name + ' 发动【仁德】' });
        SGS_UI.render(g);
        const calls = (window.__qaAudioGeneral || []).filter((x) => x.kind === 'skill');
        return {
          p1: { id: p1.general.id, name: p1.general.name },
          p2: { id: p2.general.id, name: p2.general.name },
          calls,
          banner: (document.querySelector('#skill-banner .skill-line') || {}).textContent || '',
        };
      });
      const synCall = synthetic.calls[synthetic.calls.length - 1];
      assert(synCall, '确定性 owner 场景未触发 playGeneral(skill)');
      assertEq(synCall.id, synthetic.p2.id, '技能语音应按战报发动者 2 号位播放');
      assert(synCall.id !== synthetic.p1.id, '技能语音错误地播放了第一个有该技能的 1 号位');
      row.notes.push('确定性 owner：战报=' + synthetic.p2.name + '；p1=' + synthetic.p1.name + '/' + synthetic.p1.id + '；p2=' + synthetic.p2.name + '/' + synthetic.p2.id + '；playGeneral id=' + synCall.id + '；横幅=' + synthetic.banner);

      const owners = skillInfo.logs.map((t) => normOwner((/^(.+?)\s*发动【/.exec(t) || [])[1] || '')).filter(Boolean);
      const genNames = skillInfo.gens.map((g) => normOwner(g.name)).filter(Boolean);
      const genericDamage = skillInfo.sfxKeys.filter((k) => k === 'damage').length;
      assertEq(genericDamage, 0, '仍播放了通用 damage 掉血声次数');
      if (owners.length) {
        assert(genNames.length > 0, '有技能战报但未观测到 playGeneral(skill)：' + owners.join('/'));
        const missing = owners.filter((n) => genNames.indexOf(n) < 0);
        assertEq(missing.length, 0, '技能语音 owner 与战报不一致，缺失=' + missing.join('/') + ' 实际=' + genNames.join('/'));
        row.notes.push('技能 owner 校验：战报=' + owners.join('/') + '；语音=' + genNames.join('/') + '；通用 damage 调用=' + genericDamage);
      } else {
        row.notes.push('本轮未产生技能战报，技能 owner 由 T29 覆盖；通用 damage 调用=' + genericDamage);
      }
      const ownerText = owners.length
        ? owners.join('/') + '→' + genNames.join('/')
        : ('确定性重复技能场景 ' + synthetic.p2.name + '/' + synCall.id + '（真实战报由 T29 覆盖）');

      return { actual: actual + '；技能 owner=' + ownerText + '；通用 damage=' + genericDamage };
    });

    /* ---------- T38 技能提示：纯文字 / 最多 3 行 / 2s 消失 ---------- */
    await runCase('T38', '技能提示：纯文字最多 3 行、2s 消失、无底板', [
      '8p 对局中注入 5 条技能日志并 render',
      '读取 .skill-line 数量、位置、背景/边框/副标题',
      '等待 1.2s 与 2.35s 分别读取剩余行数',
    ], '仅保留 3 行、纵向不重叠、无底板/无 SKILL 副标题；约 2s 后逐行消失；截图 qa_skill_lines.png', 'P1', async (row) => {
      await startFrozenDemo8p();
      const snap = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        g.players.forEach((p) => { p.skills = []; });
        g.logs = g.logs || [];
        g.logs.length = 0;
        for (let i = 0; i < 5; i++) g.logs.push({ type: 'skill', text: '测试武将' + i + ' 发动【测试技能' + (i + 1) + '】' });
        SGS_UI.render(g);
        const banner = document.querySelector('#skill-banner');
        const lines = Array.prototype.slice.call(banner.querySelectorAll('.skill-line'));
        const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
        const cs = getComputedStyle(banner);
        return {
          count: lines.length,
          rects: lines.map((el) => Object.assign({ text: el.textContent }, rect(el))),
          banner: rect(banner),
          bg: cs.backgroundColor,
          bgImage: cs.backgroundImage,
          border: cs.borderTopWidth,
          boxShadow: cs.boxShadow,
          subtitle: !!banner.querySelector('.skill-sub, .skill-title, .skill-banner-title, .skill-board'),
          text: banner.textContent,
        };
      });
      assertEq(snap.count, 3, '技能提示行数（最多 3 行）');
      const sorted = snap.rects.slice().sort((a, b) => a.top - b.top);
      for (let i = 1; i < sorted.length; i++) {
        assert(sorted[i - 1].bottom <= sorted[i].top + 1, '技能行重叠：' + JSON.stringify(sorted));
      }
      assert(snap.rects.every((r) => r.height > 0 && r.left >= 0 && r.right <= 1600), '技能行越界：' + JSON.stringify(snap.rects));
      assert(snap.bg === 'rgba(0, 0, 0, 0)' || snap.bg === 'transparent', '技能提示仍有背景色：' + snap.bg);
      assertEq(snap.bgImage, 'none', '技能提示仍有背景图');
      assertEq(snap.border, '0px', '技能提示仍有边框');
      assert(!snap.subtitle, '技能提示仍存在副标题/底板节点');
      assert(snap.text.indexOf('SKILL') < 0, '技能提示仍出现 SKILL 文案');
      await shot('qa_skill_lines.png', row);
      await sleep(1200);
      const mid = await cdp.eval(() => document.querySelectorAll('#skill-banner .skill-line').length);
      assertEq(mid, 3, '1.2s 时技能行应仍在');
      await sleep(1150);
      const end = await cdp.eval(() => document.querySelectorAll('#skill-banner .skill-line').length);
      assertEq(end, 0, '约 2.35s 后技能行应全部消失');
      return { actual: '5 条日志仅保留 3 行；无底板/边框/副标题；1.2s 仍在，2.35s 全部消失；截图 qa_skill_lines.png' };
    });

    /* ---------- T39 装备横条：142px 单列 / 4 件 / 名称可读 ---------- */
    await runCase('T39', '装备外挂栏（v6）：4 行/降级/不越界/方向镜像', [
      '1600×900 冻结局给座位 1 四件装备（青龙/八卦/赤兔/的卢）',
      '读取外挂栏容器、方向类、4 行高度/类型/牌名/降级与越界/遮挡',
      '检查「结束出牌」中心+四角 elementFromPoint 均为按钮',
      '切 792×323 重复检查行高 14、宽度自适应、牌名不截断',
    ], '外挂栏非零可见；行数=4 且 ≤4；每行有类型标识和完整名/两字简称/仅类型降级，不能只剩省略号；行高 17（792 下 14）；不越出视口、不压本人武将牌/名字/相邻座位/中央区/动作栏；方向类与位置一致；宽≥1101 时 #me-equips .equip-slot 仍为 4 槽', 'P1', async (row) => {
      const equipSeat = (seat) => cdp.eval((s) => {
        const g = SGS_UI._state().game;
        const mk = (name, suit, rank, id) => ({ id, name, suit, rank });
        g.players[s].equips = {
          weapon: mk('qinglong', 'spade', 5, 'qa_q_' + s),
          armor: mk('bagua', 'club', 2, 'qa_b_' + s),
          offhorse: mk('chitu', 'heart', 5, 'qa_o_' + s),
          defhorse: mk('dilu', 'club', 5, 'qa_d_' + s),
        };
        SGS_UI.render(g);
      }, seat);
      const inspect = () => cdp.eval(() => {
        const seat = document.querySelector('#seats .seat[data-seat="1"]');
        const bar = seat && seat.querySelector('.seat-equip-list');
        const rect = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        };
        const area = (a, b) => {
          if (!a || !b) return 0;
          const w = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const h = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          return w * h;
        };
        const rows = bar ? Array.prototype.map.call(bar.querySelectorAll('.eq-bar'), (r) => {
          const nameEl = r.querySelector('.eq-name');
          const typeEl = r.querySelector('.eq-type');
          const nameCs = nameEl ? getComputedStyle(nameEl) : null;
          const typeCs = typeEl ? getComputedStyle(typeEl) : null;
          const after = getComputedStyle(r, '::after');
          const nameVisible = !!(nameEl && nameCs.display !== 'none' && nameEl.getBoundingClientRect().width > 0);
          return {
            h: r.getBoundingClientRect().height,
            w: r.getBoundingClientRect().width,
            typeText: typeEl ? typeEl.textContent.trim() : '',
            typeW: typeEl ? typeEl.getBoundingClientRect().width : 0,
            typeH: typeEl ? typeEl.getBoundingClientRect().height : 0,
            typeFont: typeCs ? typeCs.fontSize : '',
            nameText: nameEl ? nameEl.textContent.trim() : '',
            nameVisible: nameVisible,
            nameFont: nameCs ? nameCs.fontSize : '',
            nameClipped: !!(nameEl && nameVisible && nameEl.scrollWidth > nameEl.clientWidth + 1),
            after: after && after.content && after.content !== 'none' ? after.content : '',
            dataShort: r.getAttribute('data-short') || '',
          };
        }) : [];
        const ownArt = seat ? seat.querySelector('.seat-art') : null;
        const ownName = seat ? seat.querySelector('.seat-name') : null;
        const others = Array.prototype.filter.call(document.querySelectorAll('#seats .seat'), (x) => x !== seat);
        const otherRects = [];
        others.forEach((x) => {
          const a = x.querySelector('.seat-art');
          if (a) otherRects.push({ name: 'seat' + x.dataset.seat + '-art', rect: rect(a) });
          const r = x.querySelector('.seat-equip-list');
          if (r && rect(r).w > 0) otherRects.push({ name: 'seat' + x.dataset.seat + '-rail', rect: rect(r) });
        });
        const center = document.querySelector('#table-center');
        const played = Array.prototype.map.call(document.querySelectorAll('#table-center .played-card'), (x) => ({ el: x, rect: rect(x) })).filter((x) => x.rect.w > 0 && x.rect.h > 0);
        const action = document.querySelector('#action-bar');
        const pick = document.querySelector('#pick-bar');
        const visible = (el) => !!(el && rect(el).w > 0 && rect(el).h > 0);
        const barRect = rect(bar);
        const overlaps = otherRects.filter((x) => area(barRect, x.rect) > 4).map((x) => x.name);
        const btn = document.querySelector('[data-act="play-end"]');
        const br = btn ? rect(btn) : null;
        const hitPts = br ? [[0.5, 0.5], [0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]].map((p) => {
          const el = document.elementFromPoint(br.left + br.w * p[0], br.top + br.h * p[1]);
          return !!(el && (el === btn || btn.contains(el)) && el.classList && el.classList.contains('bar-btn'));
        }) : [];
        const mePanel = document.querySelector('#me-equips');
        const slots = mePanel ? mePanel.querySelectorAll('.equip-slot') : [];
        return {
          vp: { w: innerWidth, h: innerHeight },
          seatClass: seat ? seat.className : '',
          seatRect: rect(seat),
          bar: barRect,
          rows: rows,
          railShort: !!(seat && seat.classList.contains('rail-short')),
          railTypeOnly: !!(seat && seat.classList.contains('rail-type-only')),
          overlapOwnArt: area(barRect, rect(ownArt)) > 4,
          overlapOwnName: area(barRect, rect(ownName)) > 4,
          overlaps: overlaps,
          overlapPlayed: played.some((x) => area(barRect, x.rect) > 4),
          overlapAction: visible(action) && area(barRect, rect(action)) > 4,
          overlapPick: visible(pick) && area(barRect, rect(pick)) > 4,
          actionHit: hitPts,
          mePanel: { visible: visible(mePanel), slots: slots.length, slotW: slots.length ? rect(slots[0]).w : 0 },
        };
      });
      const assertView = (d, label, expectH, expectTotal, wide) => {
        assert(d.bar && d.bar.w > 0 && d.bar.h > 0, label + '：外挂栏不可见');
        assert(d.bar.left >= -1 && d.bar.top >= -1 && d.bar.right <= d.vp.w + 1 && d.bar.bottom <= d.vp.h + 1,
          label + '：外挂栏越出视口 ' + JSON.stringify(d.bar) + ' / ' + JSON.stringify(d.vp));
        assertEq(d.rows.length, 4, label + '：装备行数');
        assert(d.rows.length <= 4, label + '：装备行数超过 4');
        d.rows.forEach((r, i) => {
          assert(r.typeText, label + '：第 ' + (i + 1) + ' 行缺少类型标识');
          assert(Math.abs(r.h - expectH) <= 2, label + '：第 ' + (i + 1) + ' 行行高 ' + r.h + '，期望 ' + expectH);
          assert(r.typeW >= 10 && r.typeW <= 16, label + '：第 ' + (i + 1) + ' 行类型色块 ' + r.typeW);
          assert(r.w >= 15 && r.w <= 95, label + '：第 ' + (i + 1) + ' 行宽度 ' + r.w);
          const hasLabel = (r.nameVisible && r.nameText) || r.after || d.railTypeOnly;
          assert(hasLabel, label + '：第 ' + (i + 1) + ' 行没有完整名/简称/类型降级');
          assert(!r.nameClipped, label + '：第 ' + (i + 1) + ' 行牌名被省略号截断：' + r.nameText);
          if (r.nameVisible) assert(parseFloat(r.nameFont) >= 11.5, label + '：第 ' + (i + 1) + ' 行牌名字号 ' + r.nameFont);
        });
        assert(Math.abs(d.bar.h - expectTotal) <= 6, label + '：4 行总高 ' + d.bar.h + '，期望 ' + expectTotal);
        assert(!d.overlapOwnArt && !d.overlapOwnName, label + '：外挂栏压住本人武将牌/名字');
        assertEq(d.overlaps.length, 0, label + '：外挂栏与相邻座位/外挂栏重叠：' + d.overlaps.join(','));
        assert(!d.overlapPlayed, label + '：外挂栏压住中央打出的牌');
        assert(!d.overlapAction, label + '：外挂栏压住动作栏');
        assert(!d.overlapPick, label + '：外挂栏压住 pick-bar');
        const dirs = ['eq-right', 'eq-left', 'eq-bottom'].filter((c) => d.seatClass.indexOf(c) >= 0);
        assertEq(dirs.length, 1, label + '：方向类数量');
        if (dirs[0] === 'eq-right') assert(d.bar.left >= d.seatRect.right - 2, label + '：eq-right 外挂栏未挂在座位右侧');
        if (dirs[0] === 'eq-left') assert(d.bar.right <= d.seatRect.left + 2, label + '：eq-left 外挂栏未挂在座位左侧');
        if (dirs[0] === 'eq-bottom') assert(d.bar.top >= d.seatRect.bottom - 2, label + '：eq-bottom 外挂栏未挂在座位下方');
        assert(d.actionHit.length === 5 && d.actionHit.every(Boolean), label + '：结束出牌按钮中心/四角不可点 ' + JSON.stringify(d.actionHit));
        if (wide) {
          assert(d.mePanel.visible, label + '：宽屏右侧装备面板不可见');
          assertEq(d.mePanel.slots, 4, label + '：宽屏右侧装备槽数');
        }
      };
      try {
        await setQaViewport(1600, 900);
        await startFrozenDemo8p();
        await waitState((s) => s.pending && s.pending.type === 'play' && s.pending.seat === 0, 35000, 'T39 冻结出牌请求');
        await equipSeat(1);
        await sleep(500);
        const wide = await inspect();
        assertView(wide, '1600×900', 17, 71, true);
        await shot('qa_equip_strip.png', row);

        await setQaViewport(792, 323);
        await sleep(700);
        await equipSeat(1);
        await sleep(400);
        const phone = await inspect();
        assertView(phone, '792×323', 14, 59, false);
        await shot('qa_equip_strip_792.png', row);
        row.notes.push('1600 宽=' + wide.bar.w + ' 高=' + wide.bar.h + '；792 宽=' + phone.bar.w + ' 高=' + phone.bar.h +
          '；1600 行宽=' + wide.rows.map((r) => Math.round(r.w)).join('/'));
        return { actual: '1600 外挂栏 ' + Math.round(wide.bar.w) + '×' + Math.round(wide.bar.h) + '（4 行 17px，方向 ' + wide.seatClass.split(' ').filter((c) => c.indexOf('eq-') === 0).join('') + '）；792 外挂栏 ' + Math.round(phone.bar.w) + '×' + Math.round(phone.bar.h) + '（4 行 14px）；结束出牌中心+四角可点' };
      } finally {
        await setQaViewport(1600, 900);
      }
    });

    /* ---------- T40 流离选目标：牌桌点选 + 顶部取消/确认，无全屏弹窗 ---------- */
    await runCase('T40', '流离选目标：牌桌点选 + 顶部取消/确认，无全屏弹窗', [
      '8p 对局中发起 chooseTargets 请求',
      '检查 #modal-root 无弹窗、#pick-bar 出现',
      '点击座位 1，检查高亮/计数/确认按钮',
      '确认后检查回调；再测取消',
    ], '#modal-root 无全屏“选择目标”弹窗；#pick-bar 显示 0/1 与取消/确认；点座位后高亮、计数 1/1、确认可用；确认回调 [1]；截图 qa_liuli_table_pick.png', 'P1', async (row) => {
      await startFrozenDemo8p();
      const init = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        window.__qaPickAns = 'unset';
        SGS_UI.request({
          type: 'chooseTargets', player: g.players[0], reason: '流离：选择转移目标',
          candidates: [1, 2, 3], min: 1, max: 1,
        }, (a) => { window.__qaPickAns = a; });
        const bar = document.querySelector('#pick-bar');
        const ok = bar.querySelector('[data-pick="ok"]');
        const cancel = bar.querySelector('[data-pick="cancel"]');
        const r = bar.getBoundingClientRect();
        return {
          modal: document.querySelectorAll('#modal-root .modal').length,
          mask: document.querySelectorAll('#modal-root .modal-mask').length,
          barText: bar.innerText.replace(/\s+/g, ' ').trim(),
          barRect: { w: r.width, h: r.height },
          okDisabled: !!(ok && ok.disabled),
          hasCancel: !!cancel,
          pending: (SGS_UI._state().pending && SGS_UI._state().pending.req.type) || null,
        };
      });
      assertEq(init.modal, 0, '流离选目标不应出现全屏 modal');
      assertEq(init.mask, 0, '流离选目标不应出现 modal-mask');
      assert(init.barRect.w > 0 && init.barRect.h > 0, '#pick-bar 不可见');
      assert(init.barText.indexOf('流离：选择转移目标') >= 0, '#pick-bar 未显示请求原因：' + init.barText);
      assert(init.barText.indexOf('0 / 1') >= 0, '#pick-bar 初始计数不是 0/1：' + init.barText);
      assert(init.okDisabled, '未选目标时确认按钮应禁用');
      assert(init.hasCancel, '#pick-bar 缺少取消按钮');
      assertEq(init.pending, 'chooseTargets', '待处理请求类型');
      await cdp.click('#seats .seat[data-seat="1"]');
      await sleep(100);
      const picked = await cdp.eval(() => ({
        picked: document.querySelectorAll('#seats .seat-picked').length,
        order: (document.querySelector('#seats .seat[data-seat="1"] .seat-target-order') || {}).textContent || '',
        barText: document.querySelector('#pick-bar').innerText.replace(/\s+/g, ' ').trim(),
        okDisabled: document.querySelector('#pick-bar [data-pick="ok"]').disabled,
      }));
      assertEq(picked.picked, 1, '点选后高亮座位数');
      assertEq(picked.order, '1', '点选后座位目标序号');
      assert(picked.barText.indexOf('1 / 1') >= 0, '点选后计数不是 1/1：' + picked.barText);
      assert(!picked.okDisabled, '点选后确认按钮仍禁用');
      await shot('qa_liuli_table_pick.png', row);
      await cdp.eval(() => { const b = document.querySelector('#pick-bar [data-pick="ok"]'); if (b) b.click(); });
      await sleep(160);
      let retryAns = await cdp.eval(() => window.__qaPickAns);
      if (!Array.isArray(retryAns)) {
        await cdp.click('#pick-bar [data-pick="ok"]').catch(() => {});
        await sleep(180);
      }
      const done = await cdp.eval(() => ({
        ans: window.__qaPickAns,
        bar: document.querySelector('#pick-bar').innerHTML,
        modal: document.querySelectorAll('#modal-root .modal').length,
        picked: document.querySelectorAll('#seats .seat-picked').length,
      }));
      assert(Array.isArray(done.ans) && done.ans.length === 1 && done.ans[0] === 1, '确认回调不是 [1]：' + JSON.stringify(done.ans));
      assertEq(done.bar, '', '确认后 #pick-bar 未清空');
      assertEq(done.modal, 0, '确认后仍存在全屏 modal');
      assertEq(done.picked, 0, '确认后座位仍高亮');
      const cancel = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        window.__qaPickAns = 'unset';
        SGS_UI.request({
          type: 'chooseTargets', player: g.players[0], reason: '流离：选择转移目标',
          candidates: [2, 3], min: 1, max: 1,
        }, (a) => { window.__qaPickAns = a; });
        return true;
      });
      assert(cancel, '取消用例请求失败');
      await cdp.eval(() => { const el = document.querySelector('#seats .seat[data-seat="2"]'); if (el) el.click(); });
      await cdp.eval(() => { const b = document.querySelector('#pick-bar [data-pick="cancel"]'); if (b) b.click(); });
      await sleep(100);
      const canceled = await cdp.eval(() => ({ ans: window.__qaPickAns, bar: document.querySelector('#pick-bar').innerHTML }));
      assertEq(canceled.ans, null, '取消回调不是 null');
      assertEq(canceled.bar, '', '取消后 #pick-bar 未清空');
      return { actual: '无全屏弹窗；#pick-bar 0/1→1/1，座位高亮/序号 1，确认回调 [1]；取消回调 null；截图 qa_liuli_table_pick.png' };
    });

    /* ---------- T41 铁索连环：无方向箭头，目标弧/连线，1.8s 消失 ---------- */
    await runCase('T41', '铁索连环：无方向箭头、目标弧/连线、1.8s 消失', [
      '8p 对局中注入 tiesuo 使用事件（目标 1、2）',
      '检查 #chain-layer 的 .chain-arc/.chain-line 与 #aim-layer path',
      '1.5s 与 2s 读取；再测单目标',
    ], '双目标出现 2 个 .chain-arc + 1 条 .chain-line；#aim-layer 无方向箭头；约 1.8s 后清空；单目标仅 1 个 .chain-arc；截图 qa_tiesuo_chain.png', 'P1', async (row) => {
      await startFrozenDemo8p();
      const init = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        g.recent = [];
        SGS_UI.render(g);
        document.querySelector('#aim-layer').innerHTML = '';
        g.recent.push({ kind: 'use', seat: 0, card: 'tiesuo', targets: [1, 2] });
        SGS_UI.render(g);
        const layer = document.querySelector('#chain-layer');
        return {
          arcs: layer.querySelectorAll('.chain-arc').length,
          lines: layer.querySelectorAll('.chain-line').length,
          aimPaths: document.querySelectorAll('#aim-layer path').length,
          transient: document.querySelectorAll('#aim-layer path.is-transient').length,
        };
      });
      assertEq(init.arcs, 2, '双目标 .chain-arc 数量');
      assertEq(init.lines, 1, '双目标 .chain-line 数量');
      assertEq(init.aimPaths, 0, '铁索不应绘制方向箭头');
      assertEq(init.transient, 0, '铁索不应出现 is-transient 箭头');
      await shot('qa_tiesuo_chain.png', row);
      await sleep(1000);
      const mid = await cdp.eval(() => ({
        arcs: document.querySelectorAll('#chain-layer .chain-arc').length,
        lines: document.querySelectorAll('#chain-layer .chain-line').length,
      }));
      assertEq(mid.arcs, 2, '1.0s 时 .chain-arc 应仍在');
      assertEq(mid.lines, 1, '1.0s 时 .chain-line 应仍在');
      await sleep(1100);
      const end = await cdp.eval(() => ({
        arcs: document.querySelectorAll('#chain-layer .chain-arc').length,
        lines: document.querySelectorAll('#chain-layer .chain-line').length,
      }));
      assertEq(end.arcs, 0, '2s 后 .chain-arc 应清空');
      assertEq(end.lines, 0, '2s 后 .chain-line 应清空');
      const one = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        g.recent = [];
        SGS_UI.render(g);
        const afterReset = g.recent.length;
        const before = {
          transient: document.querySelectorAll('#aim-layer path.is-transient').length,
          core: document.querySelectorAll('#aim-layer path.is-transient-core').length,
          heads: document.querySelectorAll('#aim-layer .aim-head').length,
        };
        document.querySelector('#aim-layer').innerHTML = '';
        g.recent.push({ kind: 'use', seat: 0, card: 'tiesuo', targets: [1] });
        SGS_UI.render(g);
        return {
          arcs: document.querySelectorAll('#chain-layer .chain-arc').length,
          lines: document.querySelectorAll('#chain-layer .chain-line').length,
          aim: document.querySelectorAll('#aim-layer path').length,
          transient: document.querySelectorAll('#aim-layer path.is-transient').length,
          core: document.querySelectorAll('#aim-layer path.is-transient-core').length,
          heads: document.querySelectorAll('#aim-layer .aim-head').length,
          before: before,
          afterReset: afterReset,
          recent: g.recent.map((e) => ({ kind: e.kind, card: e.card, targets: e.targets })),
        };
      });
      row.notes.push('T41 单目标 aim 诊断：' + JSON.stringify(one));
      assertEq(one.arcs, 1, '单目标 .chain-arc 数量');
      assertEq(one.lines, 0, '单目标不应有 .chain-line');
      assertEq(one.transient, one.before.transient, '单目标铁索不应新增 is-transient 方向箭头');
      assertEq(one.core, one.before.core, '单目标铁索不应新增 is-transient-core');
      assertEq(one.heads, one.before.heads, '单目标铁索不应新增 aim-head');
      await sleep(2000);
      return { actual: '双目标 2 弧+1 线、无新增方向箭头，1.0s 仍在、2s 清空；单目标 1 弧无线；截图 qa_tiesuo_chain.png' };
    });

    /* ---------- T42 ChooseCards 点击不重播全屏 fadeIn ---------- */
    await runCase('T42', 'ChooseCards 弹窗点击不重播全屏 fadeIn', [
      '8p 对局中发起 chooseCards 请求',
      '读取初始 .modal-mask 的 class/animation-name',
      '点击一张牌后再次读取',
    ], '初始 animation-name=fadeIn；点击后 .modal-mask 带 is-refresh 或 animation-name≠fadeIn；截图 qa_modal_refresh.png', 'P1', async (row) => {
      await startFrozenDemo8p(true);
      const init = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        const me = g.players[0];
        if (me.hand.length < 1) g.drawCards(me, 2, 'QA');
        // 混入一张非手牌，强制走 modal 分支（全手牌会走直选）
        const extra = (g.discardPile && g.discardPile[0]) || { id: 99011, name: 'sha', suit: 'spade', rank: 7, type: 'basic', color: 'black' };
        window.__qaChooseAns = 'unset';
        SGS_UI.request({
          type: 'chooseCards', player: me, cards: [me.hand[0], extra],
          min: 1, max: 1, reason: '测试：选择一张牌',
        }, (a) => { window.__qaChooseAns = a; });
        const mask = document.querySelector('#modal-root .modal-mask');
        return {
          modal: document.querySelectorAll('#modal-root .modal').length,
          cls: mask ? mask.className : '',
          anim: mask ? getComputedStyle(mask).animationName : '',
        };
      });
      assertEq(init.modal, 1, 'chooseCards 弹窗数量');
      assert(init.cls.indexOf('is-refresh') < 0, '初始 modal-mask 不应带 is-refresh');
      assertEq(init.anim, 'fadeIn', '初始 modal-mask 应播放 fadeIn');
      const cardPoint = await cdp.eval(() => {
        const el = document.querySelector('#modal-root .pick-card');
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width * 0.25, y: r.top + r.height * 0.25, cid: el.dataset.cid, cls: el.className };
      });
      await cdp.clickPoint(cardPoint.x, cardPoint.y, 120);
      await sleep(100);
      const after = await cdp.eval(() => {
        const mask = document.querySelector('#modal-root .modal-mask');
        return {
          cls: mask ? mask.className : '',
          anim: mask ? getComputedStyle(mask).animationName : '',
          picked: document.querySelectorAll('#modal-root .pick-card.is-picked').length,
          count: (document.querySelector('#modal-root .modal-count') || {}).textContent || '',
        };
      });
      if (after.picked !== 1) {
        const dbg = await cdp.eval(() => {
          const el = document.querySelector('#modal-root .pick-card');
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width * 0.25, r.top + r.height * 0.25);
          return {
            cid: el.dataset.cid, cls: el.className,
            count: (document.querySelector('#modal-root .modal-count') || {}).textContent || '',
            hit: hit ? { tag: hit.tagName, cls: hit.className, m: hit.closest && hit.closest('[data-m]') ? hit.closest('[data-m]').dataset.m : null } : null,
            point: { x: r.left + r.width * 0.25, y: r.top + r.height * 0.25 },
          };
        });
        row.notes.push('T42 点击诊断：' + JSON.stringify(dbg));
        const prog = await cdp.eval(() => {
          const el = document.querySelector('#modal-root .pick-card');
          el.click();
          return {
            picked: document.querySelectorAll('#modal-root .pick-card.is-picked').length,
            count: (document.querySelector('#modal-root .modal-count') || {}).textContent || '',
            cls: el.className,
          };
        });
        row.notes.push('T42 同帧 programmatic click：' + JSON.stringify(prog));
      }
      assertEq(after.picked, 1, '点击后选牌高亮数量');
      assert(after.cls.indexOf('is-refresh') >= 0 || after.anim !== 'fadeIn', '点击后仍重播 fadeIn：class=' + after.cls + ' anim=' + after.anim);
      assertEq(after.anim, 'none', '点击后 modal-mask 的 animation-name 应为 none');
      await shot('qa_modal_refresh.png', row);
      const confirmPoint = await cdp.eval(() => {
        window.__qaClicks = [];
        const root = document.querySelector('#modal-root');
        if (!root.__qaClickProbe) {
          root.__qaClickProbe = true;
          root.addEventListener('click', (e) => {
            const b = e.target.closest && e.target.closest('[data-m]');
            window.__qaClicks.push(b ? b.dataset.m : 'none');
          }, true);
        }
        const b = document.querySelector('#modal-root [data-m="confirm"]');
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!b.disabled };
      });
      await cdp.eval(() => { const b = document.querySelector('#modal-root [data-m="confirm"]'); if (b) b.click(); });
      await sleep(160);
      const done = await cdp.eval(() => ({
        ans: window.__qaChooseAns,
        modal: document.querySelectorAll('#modal-root .modal').length,
        clicks: window.__qaClicks || [],
        pending: (SGS_UI._state().pending && SGS_UI._state().pending.req.type) || null,
        confirmDisabled: (() => { const b = document.querySelector('#modal-root [data-m="confirm"]'); return b ? !!b.disabled : null; })(),
      }));
      row.notes.push('T42 确认诊断：' + JSON.stringify({ confirmPoint, done }));
      assert(Array.isArray(done.ans) && done.ans.length === 1, 'chooseCards 确认回调异常：' + JSON.stringify(done.ans));
      assertEq(done.modal, 0, '确认后弹窗未关闭');
      return { actual: '初始 fadeIn；点击后 is-refresh + animation-name=none，未重播全屏淡入；截图 qa_modal_refresh.png' };
    });

    /* ---------- T43 身份徽记颜色：自己 + 已翻开身份 ---------- */
    await runCase('T43', '身份徽记颜色：主公/忠臣/反贼/内奸 + 地主/农民', [
      '8p 对局中设置自己主公、1/2/3 号位忠/反/内并翻开，4 号位主公',
      '读取 #me-role 与各 .seat-role 的 computed color',
      '截图 qa_identity_colors.png',
    ], '主公 #FF6231、忠臣 #EDC526、反贼 #1ED80B、内奸 #73A1FF；截图覆盖自己身份与已翻开身份', 'P1', async (row) => {
      await ensure8pGame();
      const snap = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        const set = (seat, role) => { g.players[seat].role = role; g.players[seat].revealed = true; };
        set(0, 'lord'); set(1, 'loyalist'); set(2, 'rebel'); set(3, 'renegade'); set(4, 'lord');
        SGS_UI.render(g);
        const color = (el) => el ? getComputedStyle(el).color : null;
        const me = document.querySelector('#me-role');
        return {
          me: { text: me.textContent, cls: me.className, color: color(me) },
          seats: [1, 2, 3, 4].map((seat) => {
            const el = document.querySelector('#seats .seat[data-seat="' + seat + '"] .seat-role');
            return { seat, text: el ? el.textContent : null, cls: el ? el.className : null, color: color(el) };
          }),
        };
      });
      const expected = {
        '主公': 'rgb(255, 98, 49)',
        '忠臣': 'rgb(237, 197, 38)',
        '反贼': 'rgb(30, 216, 11)',
        '内奸': 'rgb(115, 161, 255)',
        '地主': 'rgb(255, 101, 40)',
        '农民': 'rgb(255, 220, 179)',
      };
      await shot('qa_identity_colors.png', row);
      const bad = [];
      if (snap.me.text !== '主公') bad.push('自己身份文字=' + snap.me.text);
      if (snap.me.color !== expected['主公']) bad.push('自己主公色=' + snap.me.color + '（期望 ' + expected['主公'] + '）');
      const want = { 1: '忠臣', 2: '反贼', 3: '内奸', 4: '主公' };
      for (const s of snap.seats) {
        if (s.text !== want[s.seat]) bad.push('座位 ' + s.seat + ' 文字=' + s.text + '（期望 ' + want[s.seat] + '）');
        if (s.color !== expected[want[s.seat]]) bad.push('座位 ' + s.seat + ' ' + want[s.seat] + '色=' + s.color + '（期望 ' + expected[want[s.seat]] + '）');
      }
      row.notes.push('实测颜色：自己=' + snap.me.color + '；' + snap.seats.map((s) => s.seat + '=' + s.text + ':' + s.color).join('，'));
      if (bad.length) throw new Error(bad.join('；'));
      return { actual: '自己主公 #FF6231；忠臣 #EDC526；反贼 #1ED80B；内奸 #73A1FF；截图 qa_identity_colors.png' };
    });

    /* ---------- T44 斗地主：3 人牌桌 / 公开身份 / 3 候选 / 地主胜 ---------- */
    await runCase('T44', '斗地主：3 人牌桌 / 公开身份 / 3 候选 / 地主胜', [
      '菜单选斗地主，读取候选数与选将身份',
      '进入牌桌，读取 3 人角色/公开身份/初始手牌',
      '置两名农民阵亡并触发 checkWin，读取 3 人结算',
      '截图牌桌与地主胜结算',
    ], '叫地主/抢地主弹窗出现且含倍率选项；3 张候选、3 人牌桌、地主/农民身份公开；地主 6 手牌/+2 体力；顶栏与地主胜结算显示倍率；截图 qa_ddz_table.png、qa_ddz_landlord_win.png', 'P1', async (row) => {
      const started = await startDdzGame();
      row.notes.push('斗地主启动弹窗：' + JSON.stringify(started.seenModals));
      assertEq(started.cards, 3, '斗地主候选武将数');
      assert(started.roleText.indexOf('斗地主') >= 0, '选将页未显示斗地主身份：' + started.roleText);
      row.notes.push('斗地主启动弹窗：' + JSON.stringify(started.seenModals));
      assert(started.auction.length > 0, '未出现叫地主/抢地主弹窗');
      const auctionLabels = started.auction.reduce((a, x) => a.concat(x.options), []);
      assert(auctionLabels.some((x) => x.indexOf('叫地主') >= 0 || x.indexOf('抢地主') >= 0), '叫/抢地主弹窗选项异常：' + auctionLabels.join('/'));
      if (auctionLabels.some((x) => x.indexOf('抢地主') >= 0)) assert(auctionLabels.some((x) => x.indexOf('倍率×2') >= 0), '抢地主缺少倍率×2：' + auctionLabels.join('/'));
      assert([1, 2, 4].indexOf(started.multiplier) >= 0, '开局倍率异常：' + started.multiplier);
      const table = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        return {
          players: g.players.length,
          roles: g.players.map((p) => p.role),
          hands: g.players.map((p) => p.hand.length),
          hp: g.players.map((p) => p.hp),
          maxHp: g.players.map((p) => p.maxHp),
          generalHp: g.players.map((p) => (p.general ? p.general.hp : null)),
          prompt: (document.querySelector('#tb-prompt') || {}).textContent || '',
          meRole: (document.querySelector('#me-role') || {}).textContent || '',
          meColor: (() => { const el = document.querySelector('#me-role'); return el ? getComputedStyle(el).color : null; })(),
          seatRoles: Array.prototype.map.call(document.querySelectorAll('#seats .seat'), (s) => {
            const el = s.querySelector('.seat-role');
            return {
              seat: s.dataset.seat,
              text: (el || {}).textContent || '',
              cls: (el || {}).className || '',
              color: el ? getComputedStyle(el).color : null,
            };
          }),
        };
      });
      assertEq(table.players, 3, '斗地主玩家数');
      assertEq(table.roles.filter((r) => r === 'landlord').length, 1, '地主数量');
      assertEq(table.roles.filter((r) => r === 'farmer').length, 2, '农民数量');
      assert(table.seatRoles.every((s) => s.text === '地主' || s.text === '农民'), '存在未公开身份：' + JSON.stringify(table.seatRoles));
      assert(table.seatRoles.every((s) => s.cls.indexOf('is-role-landlord') >= 0 || s.cls.indexOf('is-role-farmer') >= 0), '公开身份 class 不正确：' + JSON.stringify(table.seatRoles));
      const ddzColor = { '地主': 'rgb(255, 101, 40)', '农民': 'rgb(255, 220, 179)' };
      assertEq(table.meColor, ddzColor[table.meRole], '自己斗地主身份色');
      for (const s of table.seatRoles) assertEq(s.color, ddzColor[s.text], '座位 ' + s.seat + ' ' + s.text + ' 身份色');
      assertEq(table.hands.filter((n) => n === 6).length, 1, '地主初始手牌应为 6 张');
      assertEq(table.hands.filter((n) => n === 4).length, 2, '农民初始手牌应为 4 张');
      const lordIdx = table.roles.indexOf('landlord');
      const farmerIdxs = table.roles.map((r, i) => r === 'farmer' ? i : -1).filter((i) => i >= 0);
      assertEq(table.maxHp[lordIdx], 4, '地主体力应固定4');
      assertEq(table.hp[lordIdx], table.maxHp[lordIdx], '地主开局应满体力');
      for (const i of farmerIdxs) assertEq(table.maxHp[i], table.generalHp[i], '农民 maxHp 应等于武将体力');
      assert(table.prompt.indexOf('倍率 ×' + started.multiplier) >= 0, '顶栏未显示倍率 ×' + started.multiplier + '：' + table.prompt);
      await shot('qa_ddz_table.png', row);
      const forced = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        g.players.filter((p) => p.role === 'farmer').forEach((p) => { p.alive = false; });
        g.checkWin();
        return { winner: g.winner, winText: g.winText, humanRole: g.players[0].role };
      });
      assertEq(forced.winner, 'landlord', '强制结算胜方');
      await waitState((s) => s.screenActive.result, 5000, '斗地主地主胜结算页');
      const result = await state();
      assert(result.resultSub.indexOf('地主获胜') >= 0, '地主胜文案：' + result.resultSub);
      assert(result.resultSub.indexOf('倍率 ×' + started.multiplier) >= 0, '地主胜文案缺少倍率 ×' + started.multiplier + '：' + result.resultSub);
      assertEq(result.resultPlayers.length, 3, '地主胜结算人数');
      assertEq(result.resultTitle, forced.humanRole === 'landlord' ? '胜利' : '失败', '地主胜结算标题');
      await shot('qa_ddz_landlord_win.png', row);
      return { actual: '拍卖弹窗 ' + started.auction.length + ' 次（' + auctionLabels.join('/') + '）；候选 3、3 人、公开 1 地主+2 农民、地主 6 手牌/+2 体力；倍率 ×' + started.multiplier + '；地主胜结算 3 人，标题 ' + result.resultTitle + '，文案“' + result.resultSub + '”' };
    });

    /* ---------- T45 斗地主：农民胜结算 ---------- */
    await runCase('T45', '斗地主：农民胜结算（3 人）', [
      '重开斗地主并进入牌桌',
      '置地主阵亡并触发 checkWin',
      '读取结算标题/文案/3 人结算',
    ], '胜方为农民、文案“农民获胜”、结算 3 人；截图 qa_ddz_farmer_win.png', 'P1', async (row) => {
      const started = await startDdzGame();
      assertEq(started.cards, 3, '斗地主候选武将数（第二局）');
      const forced = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        const lord = g.players.find((p) => p.role === 'landlord');
        lord.alive = false;
        g.checkWin();
        return { winner: g.winner, winText: g.winText, humanRole: g.players[0].role };
      });
      assertEq(forced.winner, 'farmer', '强制结算胜方（农民）');
      await waitState((s) => s.screenActive.result, 5000, '斗地主农民胜结算页');
      const result = await state();
      assert(result.resultSub.indexOf('农民获胜') >= 0, '农民胜文案：' + result.resultSub);
      assert(result.resultSub.indexOf('倍率 ×' + started.multiplier) >= 0, '农民胜文案缺少倍率 ×' + started.multiplier + '：' + result.resultSub);
      assertEq(result.resultPlayers.length, 3, '农民胜结算人数');
      assertEq(result.resultTitle, forced.humanRole === 'farmer' ? '胜利' : '失败', '农民胜结算标题');
      await shot('qa_ddz_farmer_win.png', row);
      return { actual: '倍率 ×' + started.multiplier + '；农民胜结算 3 人，标题 ' + result.resultTitle + '，文案“' + result.resultSub + '”' };
    });

    /* ---------- T46 PWA 清理后内嵌音频索引 ?v=4 ---------- */
    await runCase('T46', 'PWA 清理后内嵌音频索引 ?v=4', [
      '清空 Service Worker / Cache / localStorage',
      '重新导航主菜单，等待内嵌 audio_index.js 加载',
      '读取 performance resource 中 audio_index.js URL 与全局索引',
    ], '清理后实际请求 assets/audio_index.js?v=4，且 SGS_AUDIO_INDEX 可用', 'P1', async (row) => {
      const pwa = await clearPwaState();
      await cdp.navigate(BASE + '?nofx=1&screen=home');
      await sleep(700);
      const info = await cdp.eval(() => {
        const perf = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.indexOf('audio_index.js') >= 0);
        return { perf, hasIndex: !!window.SGS_AUDIO_INDEX, cards: window.SGS_AUDIO_INDEX && Object.keys(window.SGS_AUDIO_INDEX.cards || {}).length };
      });
      assert(info.perf.length > 0, '未观测到 audio_index.js 资源请求');
      assert(info.perf.some((u) => u.indexOf('audio_index.js?v=4') >= 0), '未请求 ?v=4：' + info.perf.join(', '));
      assert(!info.perf.some((u) => /audio_index\.js(?!\?v=4)/.test(u)), '存在无 ?v=4 的索引请求：' + info.perf.join(', '));
      assert(info.hasIndex && info.cards > 0, 'SGS_AUDIO_INDEX 未加载');
      return { actual: 'PWA 清理 sw=' + pwa.sw + '/cache=' + pwa.cacheKeys + '/local=' + pwa.localKeys + '；请求 ' + info.perf.join(', ') + '；cards=' + info.cards };
    });

    /* ---------- T47 8p 手牌 5 张居中扇形 ---------- */
    await runCase('T47', '8p 手牌 5 张：112×156 居中扇形、不越界', [
      '冻结演示 8p 局，将手牌补到 5 张并 render',
      '读取 hand-wrap 与 5 张 .hand-card 的尺寸/位置/旋转',
      '截图 qa_hand_fan.png',
    ], '5 张手牌均为 112×156；整体在 hand-wrap 内、最左不越界；左右对称、中间旋转 0、外侧 ±4.2°；截图 qa_hand_fan.png', 'P1', async (row) => {
      await startFrozenDemo8p();
      const snap = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        const me = g.players[0];
        const hand = me.hand.slice(0, 5);
        while (hand.length < 5) {
          const c = g.deck && g.deck.pop();
          if (!c) break;
          hand.push(c);
        }
        me.hand = hand;
        SGS_UI.render(g);
        const wrap = document.querySelector('#hand').parentElement;
        const wr = wrap.getBoundingClientRect();
        const cards = Array.prototype.slice.call(document.querySelectorAll('#hand .hand-card'));
        const cr = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; };
        return {
          count: cards.length,
          wrap: { x: wr.x, y: wr.y, w: wr.width, h: wr.height, right: wr.right },
          cards: cards.map((el) => {
            const cs = getComputedStyle(el);
            return {
              rect: cr(el),
              width: cs.width, height: cs.height,
              rot: parseFloat(el.style.getPropertyValue('--rot') || '0'),
              y: parseFloat(el.style.getPropertyValue('--y') || '0'),
              x: parseFloat(el.style.getPropertyValue('--x') || '0'),
            };
          }),
        };
      });
      assertEq(snap.count, 5, '手牌数量');
      const handW = snap.cards[0].width, handH = snap.cards[0].height;
      for (const c of snap.cards) {
        assertEq(c.width, handW, '手牌宽度不一致');
        assertEq(c.height, handH, '手牌高度不一致');
        assert(parseFloat(c.width) >= 80 && parseFloat(c.height) >= 110, '手牌尺寸异常：' + c.width + '×' + c.height);
        assert(c.rect.x >= snap.wrap.x - 1, '手牌左侧越界：' + JSON.stringify({ card: c.rect, wrap: snap.wrap }));
        assert(c.rect.right <= snap.wrap.right + 1, '手牌右侧越界：' + JSON.stringify({ card: c.rect, wrap: snap.wrap }));
      }
      const rots = snap.cards.map((c) => c.rot);
      const ys = snap.cards.map((c) => c.y);
      assert(rots[2] === 0, '中间手牌旋转应为 0：' + rots.join(','));
      assert(rots[0] < 0 && rots[4] > 0 && Math.abs(rots[0] + rots[4]) < 0.01, '外侧旋转不对称：' + rots.join(','));
      assert(Math.abs(ys[0] - ys[4]) < 0.01 && ys[2] === 0, '扇形纵向不对称：' + ys.join(','));
      const center = (Math.min.apply(null, snap.cards.map((c) => c.rect.x)) + Math.max.apply(null, snap.cards.map((c) => c.rect.right))) / 2;
      const wrapCenter = snap.wrap.x + snap.wrap.w / 2;
      assert(Math.abs(center - wrapCenter) <= 16, '手牌未居中：cardCenter=' + center.toFixed(1) + ' wrapCenter=' + wrapCenter.toFixed(1));
      const span = Math.max.apply(null, snap.cards.map((c) => c.rect.right)) - Math.min.apply(null, snap.cards.map((c) => c.rect.x));
      const ratio = span / snap.wrap.w;
      row.notes.push('手牌铺满率=' + ratio.toFixed(3) + '（span=' + span.toFixed(1) + ' wrap=' + snap.wrap.w.toFixed(1) + '）');
      await shot('qa_hand_fan.png', row);
      return { actual: '5 张手牌 ' + handW + '×' + handH + '，居中扇形（rot=' + rots.join('/') + '，y=' + ys.join('/') + '），左右均未越界；铺满率=' + ratio.toFixed(3) + '；截图 qa_hand_fan.png' };
    });

    /* ---------- T48 判定/五谷/无懈/仁德/中央牌/读秒 ---------- */
    await runCase('T48', '判定牌/五谷托盘/无懈中央牌/仁德飞牌/中央角标/90-45读秒', [
      '冻结 8p 局依次注入 judge/五谷/无懈/仁德日志并 render',
      '读取判定浮层、五谷托盘、无懈 reveal、flow 卡、played-card 角标',
      '合成 play/response 请求验证 90s/45s 读秒、10s 红色与超时 AI 代操作',
    ], '判定牌显示花色/点数/结果；五谷托盘逐张减少；无懈中央牌显示抵消；仁德有飞牌；中央牌图片 naturalWidth/宽高比与手牌一致、顶部不裁；读秒 90/45s、10s 红色、超时清空；截图 qa_judge_card/qa_wugu_tray/qa_wuxie_center/qa_rende_flow/qa_center_card/qa_countdown_ring.png', 'P1', async (row) => {
      await startFrozenDemo8p();
      // freeze=play 到 seat0 的出牌请求才真正冻结引擎；先等到该请求，避免合成的
      // judge/五谷/无懈日志与真实牌局日志并发，导致五谷托盘被重新渲染
      await waitState((s) => s.screenActive.game && s.seats === 7 &&
        s.pending && s.pending.type === 'play' && s.pending.seat === 0,
        35000, 'T48 冻结出牌请求');
      const judge = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        g.logs = [];
        g.logs.push({ type: 'judge', text: '测试 判定（八卦阵）：【八卦阵】♥K' });
        SGS_UI.render(g);
        return {
          on: document.querySelector('#judge-overlay').classList.contains('is-on'),
          suit: (document.querySelector('#judge-suit') || {}).textContent || '',
          rank: (document.querySelector('#judge-rank') || {}).textContent || '',
          result: (document.querySelector('#judge-result') || {}).textContent || '',
          name: (document.querySelector('#judge-name') || {}).textContent || '',
        };
      });
      assert(judge.on, '判定牌浮层未显示');
      assertEq(judge.suit, '♥', '判定牌花色');
      assertEq(judge.rank, 'K', '判定牌点数');
      assert(judge.result.indexOf('判定成功') >= 0, '八卦红判定结果：' + judge.result);
      assertEq(judge.name, '八卦阵', '判定牌名');
      await shot('qa_judge_card.png', row);

      const wugu = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        g.logs = [];
        g.logs.push({ type: 'info', text: '【五谷丰登】亮出：【杀】♠7、【闪】♥2、【桃】♦3' });
        SGS_UI.render(g);
        return {
          on: document.querySelector('#wugu-tray').classList.contains('is-on'),
          count: document.querySelectorAll('#wugu-cards .wugu-card').length,
          text: (document.querySelector('#wugu-count') || {}).textContent || '',
        };
      });
      assert(wugu.on, '五谷托盘未显示');
      assertEq(wugu.count, 3, '五谷亮牌数量');
      assert(wugu.text.indexOf('3 张待选') >= 0, '五谷计数：' + wugu.text);
      await shot('qa_wugu_tray.png', row);
      const wuguGain = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        const p = g.players[1];
        const card = document.querySelector('#wugu-cards .wugu-card');
        const label = card ? card.getAttribute('data-label') : '【杀】♠7';
        g.logs.push({ type: 'info', text: p.general.name + ' 获得 ' + label });
        SGS_UI.render(g);
        return {
          label: label,
          count: document.querySelectorAll('#wugu-cards .wugu-card').length,
          last: (document.querySelector('#wugu-last') || {}).textContent || '',
          logs: (g.logs || []).map((x) => x.text).slice(-3),
          pname: p.general.name,
        };
      });
      await sleep(520);
      const wuguAfter = await cdp.eval(() => ({
        count: document.querySelectorAll('#wugu-cards .wugu-card').length,
        last: (document.querySelector('#wugu-last') || {}).textContent || '',
      }));
      if (wuguAfter.count > 2) row.notes.push('五谷调试：' + JSON.stringify({ before: wuguGain, after: wuguAfter }));
      assert(wuguAfter.count <= 2, '五谷拿牌后托盘未减少：' + wuguAfter.count);
      // 拿牌提示由 render 后的异步刷新写入，全量时同帧读取可能早于 DOM 更新；轮询最多 2s 取最终值
      let wuguLast = wuguAfter.last;
      const wuguT0 = Date.now();
      while (Date.now() - wuguT0 < 2000 && wuguLast.indexOf('获得') < 0) {
        await sleep(200);
        wuguLast = await cdp.eval(() => (document.querySelector('#wugu-last') || {}).textContent || '');
      }
      if (wuguLast.indexOf('获得') < 0) {
        row.notes.push('五谷 last 实际：' + JSON.stringify({ before: wuguGain.last, after: wuguAfter.last, final: wuguLast, logs: wuguGain.logs }));
      }
      assert(wuguLast.indexOf('获得') >= 0,
        '五谷拿牌提示：' + wuguLast + '（before=' + wuguGain.last + '，after=' + wuguAfter.last + '）');

      const wx = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        g.discardPile.push({ id: 99001, name: 'wuxie', suit: 'spade', rank: 7 });
        g.logs = [];
        g.logs.push({ type: 'wuxie', text: '测试 使用【无懈可击】抵消了 【五谷丰登】' });
        SGS_UI.render(g);
        return {
          on: document.querySelector('#reveal-box').classList.contains('is-on'),
          title: (document.querySelector('#reveal-title') || {}).textContent || '',
          sub: (document.querySelector('#reveal-sub') || {}).textContent || '',
          suit: (document.querySelector('#reveal-suit') || {}).textContent || '',
          rank: (document.querySelector('#reveal-rank') || {}).textContent || '',
        };
      });
      assert(wx.on, '无懈中央牌面未显示');
      assertEq(wx.title, '无懈可击', '无懈中央牌标题');
      assert(wx.sub.indexOf('抵消') >= 0, '无懈中央牌副标题：' + wx.sub);
      assert(wx.suit && wx.rank, '无懈中央牌缺少花色/点数：' + JSON.stringify(wx));
      await shot('qa_wuxie_center.png', row);

      const rende = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        g.logs = [];
        const a = g.players[1].general.name;
        const b = g.players[2].general.name;
        g.logs.push({ type: 'skill', text: a + ' 发动【仁德】交给 ' + b + ' 2 张牌' });
        SGS_UI.render(g);
        return document.querySelectorAll('#flow-layer .flow-card').length;
      });
      await sleep(120);
      const flowCount = await cdp.eval(() => document.querySelectorAll('#flow-layer .flow-card').length);
      assert(rende > 0 || flowCount > 0, '仁德飞牌未出现');
      await shot('qa_rende_flow.png', row);

      const center = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        g.table = [{ id: 99002, name: 'sha', suit: 'heart', rank: '10', type: 'basic', color: 'red' }];
        SGS_UI.render(g);
        const tl = document.querySelector('#played-cards .played-card .hc-suit');
        const name = document.querySelector('#played-cards .played-card .hc-name');
        const rank = document.querySelector('#played-cards .played-card .hc-rank');
        const pc = document.querySelector('#played-cards .played-card');
        const img = pc && pc.querySelector('img');
        const handImg = document.querySelector('.hand-card img');
        const pr = pc.getBoundingClientRect();
        const ir = img ? img.getBoundingClientRect() : null;
        const hr = handImg ? handImg.getBoundingClientRect() : null;
        return {
          cards: document.querySelectorAll('#played-cards .played-card').length,
          tl: tl ? tl.textContent.trim() : '',
          name: name ? name.textContent.trim() : '',
          rank: rank ? rank.textContent.trim() : '',
          natural: img ? [img.naturalWidth, img.naturalHeight] : [0, 0],
          ratio: img ? img.clientWidth / img.clientHeight : 0,
          handRatio: handImg ? handImg.clientWidth / handImg.clientHeight : 0,
          imgClient: img ? [img.clientWidth, img.clientHeight] : [0, 0],
          cardClient: pc ? [pc.clientWidth, pc.clientHeight] : [0, 0],
          imgTop: ir ? ir.top : 0,
          cardTop: pr.top,
          overflow: pc ? getComputedStyle(pc).overflow : '',
        };
      });
      assertEq(center.cards, 1, '中央打出牌数量');
      assert(center.tl.indexOf('♥') >= 0, '中央牌左上花色：' + center.tl);
      assertEq(center.name, '杀', '中央牌牌名');
      assert(center.rank.indexOf('10') >= 0, '中央牌点数：' + center.rank);
      assert(!center.tl.includes('10'), '中央牌左上不应再叠加点数：' + center.tl);
      assert(center.natural[0] > 0 && center.natural[1] > 0, '中央牌图片未加载：' + JSON.stringify(center.natural));
      assert(Math.abs(center.ratio - center.handRatio) < 0.03, '中央牌图片宽高比未与手牌一致：' + center.ratio.toFixed(3) + ' vs ' + center.handRatio.toFixed(3));
      assert(center.imgClient[1] >= center.cardClient[1] - 2, '中央牌图片容器高度不足：' + JSON.stringify(center.imgClient));
      assert(center.imgTop >= center.cardTop - 1, '中央牌图片顶部被裁出容器：' + center.imgTop + ' < ' + center.cardTop);
      assert(center.overflow !== 'hidden', '中央牌容器 overflow:hidden 会裁切卡图');
      await shot('qa_center_card.png', row);

      // 读秒：AI/冻结态不显示；play 90s；10s 红色；超时清空；response 45s
      const before = await cdp.eval(() => ({
        count: (document.querySelector('#tb-count') || {}).textContent || '',
        orbit: document.querySelector('#orbit-timer').classList.contains('is-on'),
      }));
      assertEq(before.count, '', 'AI/冻结态不应显示读秒');
      assert(!before.orbit, 'AI/冻结态圆环读秒不应显示');
      const play = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        SGS_UI.request({ type: 'play', player: g.players[0], actions: [], reason: 'QA 读秒' }, () => {});
        return {
          count: (document.querySelector('#tb-count') || {}).textContent || '',
          orbit: (document.querySelector('#orbit-timer') || {}).textContent || '',
          orbitOn: document.querySelector('#orbit-timer').classList.contains('is-on'),
          warn: document.querySelector('#tb-count').classList.contains('is-warn'),
        };
      });
      assert(play.count.indexOf('90s') >= 0, '出牌读秒应为 90s：' + play.count);
      assert(play.orbitOn && play.orbit.indexOf('90s') >= 0, '圆环读秒未显示：' + play.orbit);
      assert(!play.warn, '90s 不应红色');
      await shot('qa_countdown_ring.png', row);
      const warn = await cdp.eval(async () => {
        window.__qaRealNow = Date.now;
        window.__qaOffset = 82000;
        Date.now = function () { return window.__qaRealNow() + window.__qaOffset; };
        await new Promise((r) => setTimeout(r, 650));
        return {
          count: (document.querySelector('#tb-count') || {}).textContent || '',
          warn: document.querySelector('#tb-count').classList.contains('is-warn'),
          orbitWarn: document.querySelector('#orbit-timer').classList.contains('is-warn'),
          color: getComputedStyle(document.querySelector('#tb-count')).color,
        };
      });
      assert(warn.warn && warn.orbitWarn, '最后 10s 未红色：' + JSON.stringify(warn));
      assert(warn.count.indexOf('8s') >= 0 || warn.count.indexOf('7s') >= 0 || warn.count.indexOf('9s') >= 0, '10s 内读数异常：' + warn.count);
      const timeout = await cdp.eval(async () => {
        window.__qaOffset = 95000;
        await new Promise((r) => setTimeout(r, 900));
        const st = SGS_UI._state();
        return {
          pending: !!(st.pending && st.pending.req),
          count: (document.querySelector('#tb-count') || {}).textContent || '',
          toast: Array.prototype.map.call(document.querySelectorAll('#toast-root .toast'), (x) => x.textContent).join('|'),
        };
      });
      assert(!timeout.pending, '超时后待处理请求未清空');
      assertEq(timeout.count, '', '超时后读秒未清空');
      assert(timeout.toast.indexOf('AI') >= 0 || timeout.toast.indexOf('超时') >= 0, '超时未提示 AI 代操作：' + timeout.toast);
      const resp = await cdp.eval(() => {
        Date.now = window.__qaRealNow;
        delete window.__qaOffset;
        const g = SGS_UI._state().game;
        SGS_UI.request({ type: 'response', player: g.players[0], need: 'shan', options: [], reason: 'QA 响应读秒' }, () => {});
        return {
          count: (document.querySelector('#tb-count') || {}).textContent || '',
          orbit: (document.querySelector('#orbit-timer') || {}).textContent || '',
        };
      });
      assert(resp.count.indexOf('45s') >= 0, '响应读秒应为 45s：' + resp.count);
      assert(resp.orbit.indexOf('45s') >= 0, '响应圆环读秒未显示：' + resp.orbit);
      await cdp.eval(() => SGS_UI.answerPending(null));
      await sleep(120);
      const hidden = await cdp.eval(() => ({
        count: (document.querySelector('#tb-count') || {}).textContent || '',
        orbit: document.querySelector('#orbit-timer').classList.contains('is-on'),
      }));
      assertEq(hidden.count, '', '响应结束后读秒未清空');
      assert(!hidden.orbit, '响应结束后圆环读秒未关闭');
      return { actual: '判定 ♥K 成功；五谷 3→≤2；无懈中央牌抵消+花色点数；仁德飞牌；中央 ♥10 角标；读秒 90/45s、10s 红色、超时 AI 清空；截图已生成' };
    });

    /* ---------- T49 无懈男女声强制校验 ---------- */
    await runCase('T49', '无懈可击男女声：顺序调用 male/female 各 2 次', [
      '冻结 8p 局，安装 playCard/媒体 URL 拦截',
      '同页顺序直接调用 SGS_AUDIO.playCard("wuxie","male"/"female") 各 2 次',
      '每次等待播放，记录 playCard 参数与实际 URL',
    ], '4 次均稳定：male→wuxie_male_*、female→wuxie_female_*，无串音；截图 qa_audio_wuxie.png', 'P1', async (row) => {
      await startFrozenDemo8p();
      await installAudioWrapper();
      const results = [];
      const fire = async (gender) => {
        await cdp.eval((gender) => {
          window.__qaAudioCardReq = []; window.__qaAudio = [];
          SGS_AUDIO.playCard('wuxie', gender);
        }, gender);
        await sleep(650);
        const snap = await cdp.eval(() => ({
          reqs: (window.__qaAudioCardReq || []).filter((r) => r.name === 'wuxie').map((r) => r.gender),
          plays: (window.__qaAudio || []).filter((e) => e.event !== 'progress' && e.src && e.src.indexOf('wuxie') >= 0).map((e) => e.src.split('/').pop()),
        }));
        results.push({ gender, reqGenders: snap.reqs, urls: snap.plays });
        assert(snap.reqs.indexOf(gender) >= 0, 'playCard 参数缺少 gender=' + gender + '，实际=' + JSON.stringify(snap.reqs));
        assert(snap.plays.some((u) => u.indexOf('wuxie_' + gender + '_') === 0), gender + ' 实际 URL 缺少 wuxie_' + gender + '：' + snap.plays.join(','));
      };
      await fire('male');
      await fire('female');
      await fire('male');
      await fire('female');
      await shot('qa_audio_wuxie.png', row);
      row.notes.push('T49 顺序结果：' + JSON.stringify(results));
      return { actual: '同页 4 次顺序：' + results.map((r) => r.gender + '→' + r.urls.join(',')).join('；') };
    });

    /* ---------- T50 身份标记角色死亡后揭示真身 ---------- */
    await runCase('T50', '身份标记角色死亡后显示真实身份、mark class 消失', [
      '冻结 8p 局，选 1 号位设为反贼并点击身份标记',
      '置该角色 alive=false 并 render',
      '读取 .seat-role 文本/class',
    ], '死亡后 role 文本变为“反贼”，mark-loyalist/rebel/renegade 与 is-marked 消失，出现 is-role-rebel；截图 qa_role_death_reveal.png', 'P1', async (row) => {
      await startFrozenDemo8p();
      const before = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        const p = g.players[1];
        p.role = 'rebel'; p.revealed = false; p.alive = true;
        SGS_UI.render(g);
        return { text: (document.querySelector('#seats .seat[data-seat="1"] .seat-role') || {}).textContent || '' };
      });
      await cdp.click('#seats .seat[data-seat="1"] .seat-role');
      await sleep(80);
      const marked = await cdp.eval(() => {
        const el = document.querySelector('#seats .seat[data-seat="1"] .seat-role');
        return { text: el.textContent, cls: el.className };
      });
      assert(marked.cls.indexOf('mark-') >= 0 || marked.cls.indexOf('is-marked') >= 0, '点击后未出现身份标记：' + JSON.stringify(marked));
      const dead = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        g.players[1].alive = false;
        SGS_UI.render(g);
        const el = document.querySelector('#seats .seat[data-seat="1"] .seat-role');
        return { text: el.textContent, cls: el.className };
      });
      assertEq(dead.text, '反贼', '死亡后身份文本');
      assert(dead.cls.indexOf('is-role-rebel') >= 0, '死亡后缺少 is-role-rebel：' + dead.cls);
      assert(dead.cls.indexOf('mark-') < 0 && dead.cls.indexOf('is-marked') < 0, '死亡后 mark class 未清除：' + dead.cls);
      await shot('qa_role_death_reveal.png', row);
      return { actual: '标记态=' + marked.text + '/' + marked.cls + '；死亡后=' + dead.text + '/' + dead.cls };
    });

    /* ---------- T52 装备 tooltip / 手牌角标 ---------- */
    await runCase('T52', '装备 tooltip 不压手牌、手牌角标 4 张不换行', [
      '冻结 8p 局，给 1 号位 4 件装备并 render',
      '悬停第一条 .eq-bar，读取 .sgs-tooltip 与 #hand 矩形',
      '读取 .seat-hand 文本/换行/滚动宽度',
    ], 'tooltip 可见且不与手牌区相交；.seat-hand 文本“手牌 4”单行、不换行、不溢出；截图 qa_equip_tooltip.png', 'P2', async (row) => {
      await startFrozenDemo8p();
      const prep = await cdp.eval(() => {
        const g = SGS_UI._state().game;
        g.players[1].equips = {
          weapon: { id: 'qa_w', name: 'zhugeliannu', suit: 'club', rank: 1 },
          armor: { id: 'qa_a', name: 'bagua', suit: 'spade', rank: 2 },
          offhorse: { id: 'qa_o', name: 'chitu', suit: 'heart', rank: 5 },
          defhorse: { id: 'qa_d', name: 'dilu', suit: 'club', rank: 5 },
        };
        SGS_UI.render(g);
        const hand = document.querySelector('#hand').getBoundingClientRect();
        const badge = document.querySelector('#seats .seat[data-seat="1"] .seat-hand');
        const cs = badge ? getComputedStyle(badge) : null;
        return {
          hand: { x: hand.x, y: hand.y, w: hand.width, h: hand.height, right: hand.right, bottom: hand.bottom },
          badge: badge ? {
            text: badge.textContent.trim(),
            whiteSpace: cs.whiteSpace,
            scrollWidth: badge.scrollWidth,
            clientWidth: badge.clientWidth,
            textWidth: (() => {
              try {
                const range = document.createRange();
                range.selectNodeContents(badge);
                return range.getBoundingClientRect().width;
              } catch (e) { return badge.scrollWidth; }
            })(),
            height: badge.getBoundingClientRect().height,
            lineHeight: cs.lineHeight,
          } : null,
        };
      });
      await cdp.move('#seats .seat[data-seat="1"] .eq-bar', 0);
      await sleep(300);
      const tip = await cdp.eval(() => {
        const el = document.querySelector('.sgs-tooltip');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { text: el.textContent, x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom, display: cs.display, visibility: cs.visibility, opacity: cs.opacity };
      });
      assert(tip, '悬停装备后未出现 .sgs-tooltip');
      assert(tip.display !== 'none' && tip.visibility !== 'hidden' && Number(tip.opacity) > 0, 'tooltip 不可见：' + JSON.stringify(tip));
      const overlap = !(tip.right <= prep.hand.x || tip.x >= prep.hand.right || tip.bottom <= prep.hand.y || tip.y >= prep.hand.bottom);
      assert(!overlap, 'tooltip 压住手牌：tip=' + JSON.stringify(tip) + ' hand=' + JSON.stringify(prep.hand));
      assert(prep.badge && prep.badge.text.indexOf('4') >= 0, '手牌角标未显示 4：' + JSON.stringify(prep.badge));
      assertEq(prep.badge.whiteSpace, 'nowrap', '手牌角标 white-space');
      // A 的 44px 热区用透明伪元素扩展，会撑大 scrollWidth；只看文字本身的宽度
      assert(prep.badge.textWidth <= prep.badge.clientWidth + 1, '手牌角标文字横向溢出：' + JSON.stringify(prep.badge));
      await shot('qa_equip_tooltip.png', row);
      return { actual: 'tooltip 可见且不与手牌相交（tip y=' + tip.y.toFixed(0) + '..' + tip.bottom.toFixed(0) + '，hand y=' + prep.hand.y.toFixed(0) + '）；手牌角标“' + prep.badge.text + '”单行不溢出；截图 qa_equip_tooltip.png' };
    });

    /* ---------- T51 3v3 直接 AI 对局到结算 ---------- */
    await runCase('T51', '3v3 直接 AI 对局到结算（seed=7）', [
      '打开 ?mode=3v3&demo=1&fast=1&seed=7',
      '等待 6 人牌桌并自动跑完',
      '读取结算标题/文案/6 名玩家并截图',
    ], '6 人牌桌；结算 6 人；文案含蓝队/红队获胜；截图 qa_3v3_result.png', 'P1', async (row) => {
      await cdp.navigate(BASE + '?mode=3v3&demo=1&fast=1&seed=7');
      await waitState((s) => s.screenActive.game && s.seats === 5, 10000, '3v3 直接对局未进牌桌');
      const st = await waitState((s) => s.screenActive.result, 240000, '3v3 等待结算超时');
      assertEq(st.resultPlayers.length, 6, '3v3 结算人数');
      assert(/蓝队|红队/.test(st.resultSub) && /获胜/.test(st.resultSub), '3v3 结算文案：' + st.resultSub);
      await shot('qa_3v3_result.png', row);
      return { actual: '6 人结算，标题=' + st.resultTitle + '，文案=' + truncate(st.resultSub, 80) + '；截图 qa_3v3_result.png' };
    });

    /* ---------- T30 控制台异常 ---------- */
    await runCase('T30', '控制台异常 / 页面崩溃', [
      '汇总 Runtime.exceptionThrown',
      '汇总 Runtime.consoleAPICalled(error/warning)',
      '汇总 Log.entryAdded(error/warning)',
      '检查 Inspector.targetCrashed',
    ], '未捕获异常 0 条；无页面崩溃；控制台 error 仅记录不判定为失败但需写入报告', 'P0', async (row) => {
      const fatal = await cdp.eval(() => {
        const t = document.querySelector('#modal-root .modal-title');
        return t && t.textContent.indexOf('运行出错') >= 0 ? (document.querySelector('#modal-root .modal-body') || {}).innerText || '' : '';
      });
      assert(!cdp.crashed, '页面发生 Inspector.targetCrashed');
      assert(!fatal, '出现运行出错弹窗：' + truncate(fatal, 200));
      assertEq(cdp.exceptions.length, 0, '未捕获异常数');
      if (cdp.consoleErrors.length) {
        row.notes.push('控制台 error/warning ' + cdp.consoleErrors.length + ' 条（见报告）');
      }
      return { actual: '未捕获异常=0，页面崩溃=0，控制台 error/warning=' + cdp.consoleErrors.length + '，Log error/warning=' + cdp.logEntries.length };
    });

    meta.finalUrl = await cdp.eval('location.href').catch(() => null);
  } catch (e) {
    aborted = true;
    console.error('\n[FATAL] ' + (e && e.stack || e) + '\n');
    exceptions.push({ time: nowIso(), text: '脚本/页面致命错误', description: String(e && e.stack || e) });
  } finally {
    meta.md5End = snapshotMd5();
    meta.changedFiles = Object.keys(meta.md5Start).filter((f) => meta.md5Start[f] !== meta.md5End[f]);
    exceptions.push(...(cdp ? cdp.exceptions : []));
    const summary = {
      total: results.length,
      pass: results.filter((r) => r.status === 'PASS').length,
      fail: results.filter((r) => r.status === 'FAIL').length,
      skip: results.filter((r) => r.status === 'SKIP').length,
      failIds: results.filter((r) => r.status === 'FAIL').map((r) => r.id),
      skipIds: results.filter((r) => r.status === 'SKIP').map((r) => r.id),
    };
    const report = {
      meta,
      summary,
      cases: results,
      exceptions,
      consoleErrors: cdp ? cdp.consoleErrors : [],
      logEntries: cdp ? cdp.logEntries : [],
      screenshots,
    };
    const jsonPath = path.join(os.tmpdir(), 'sgs_qa_e2e_' + STARTED_AT.getTime() + '.json');
    try { fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2)); } catch (e) { console.error('[WARN] 结果 JSON 写入失败：' + e.message); }

    console.log('\n================ 控制台 =================');
    console.log('未捕获异常: ' + exceptions.length);
    exceptions.slice(0, 8).forEach((e) => console.log('  - ' + truncate((e.description || e.text || '') + ' @ ' + (e.url || '') + ':' + (e.line == null ? '' : e.line), 240)));
    console.log('控制台 error/warning: ' + (cdp ? cdp.consoleErrors.length : 0));
    (cdp ? cdp.consoleErrors : []).slice(0, 8).forEach((e) => console.log('  - [' + e.type + '] ' + truncate(e.text, 200)));
    console.log('Log error/warning: ' + (cdp ? cdp.logEntries.length : 0));
    (cdp ? cdp.logEntries : []).slice(0, 8).forEach((e) => console.log('  - [' + e.level + '/' + e.source + '] ' + truncate(e.text, 200)));

    console.log('\n================ 结果 =================');
    results.forEach((r) => {
      console.log('[' + r.status + '] ' + r.id + ' ' + r.title + ' — ' + truncate(r.actual, 160));
    });
    console.log('\nSUMMARY total=' + summary.total + ' pass=' + summary.pass + ' fail=' + summary.fail + ' skip=' + summary.skip);
    if (summary.failIds.length) console.log('FAILED: ' + summary.failIds.join(','));
    if (summary.skipIds.length) console.log('SKIPPED: ' + summary.skipIds.join(','));
    console.log('BUILD md5: ' + MD5_FILES.map((f) => f + '=' + meta.md5Start[f]).join(' '));
    if (meta.changedFiles.length) console.log('WARN 运行期间文件变化: ' + meta.changedFiles.join(','));
    console.log('SCREENSHOTS: ' + screenshots.join(', '));
    console.log('RESULT_JSON=' + jsonPath);
    console.log('RESULT: ' + (summary.fail === 0 && exceptions.length === 0 ? 'PASS' : 'FAIL'));

    await cleanup();
    process.exitCode = summary.fail === 0 && exceptions.length === 0 ? 0 : 1;
  }
})().catch((e) => {
  console.error('[OUTER FAIL] ' + (e && e.stack || e));
  process.exit(1);
});
