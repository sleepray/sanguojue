#!/usr/bin/env node
/*
 * 1.0.7 子 agent A：移动端/平板 UI 布局检查
 * 用法：
 *   node tools/layout_check.js                     # 5 视口全量（会滚动 latest/prev）
 *   node tools/layout_check.js --viewport=412x915 --scene=play5,target
 *   node tools/layout_check.js --viewport=323x792 --scene=all --no-shot
 * 说明：puppeteer-core 启动本机 Chrome，不下载 Chromium；只读页面，不修改业务源码。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out', 'ui');
const LATEST = path.join(OUT, 'latest');
const PREV = path.join(OUT, 'prev');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.QA_BASE || 'http://127.0.0.1:8899/';
const PROFILE = path.join(ROOT, 'out', '.chrome-profile');
const WHITE = path.join(__dirname, 'layout_whitelist.json');

const VIEWPORTS = [
  { id: '323x792', width: 323, height: 792 },
  { id: '412x915', width: 412, height: 915 },
  { id: '619x720', width: 619, height: 720 },
  { id: '800x1280', width: 800, height: 1280 },
  { id: '1280x800', width: 1280, height: 800 },
];
const FULL_MODES = ['8p', '3v3'];
const MINI_MODES = ['1v1', '5p'];
const FULL_SCENES = ['play1', 'play5', 'play10', 'play15', 'target', 'wugu', 'rescue', 'pindian', 'hidden', 'judge', 'intro', 'skilldesc', 'log', 'settings', 'pause'];
const MINI_SCENES = ['play5', 'target'];
const SELECTOR_TEXT = '.seat-name,.seat-role,.seat-hand,.seat-hp,.seat-distance,.tb-item,.tb-btn,.bar-title,.bar-sub,.skill-btn,.equip-slot,.gc-name,.gc-skill,.gc-skill-descs,.gc-pack,.modal-title,.modal-reason,.modal-body,.modal-foot,.option-btn,.rp-name,.rp-info,.rp-role,.result-title,.result-sub,.log-line,.wugu-card,.judge-card,.judge-meta,.pindian-card,.rescue-banner,.hand-reveal,#skill-banner,.select-title,.select-meta,.menu-label';
const SELECTOR_INTERACTIVE = 'button,.btn,.tb-btn,.skill-btn,.equip-slot,.hand-card,.seat,.gc-skill,.role-mark-btn';
const SELECTOR_KEY = '.seat,.hand-card,.hand,.hand-wrap,.action-bar,.topbar,.tb-right,.human,.human-left,.human-mid,.human-right,.modal,.modal-foot,.modal-body,.wugu-tray.is-on,.judge-overlay.is-on,.pindian-overlay.is-on,.rescue-banner.is-on,.hand-reveal.is-on,.settings-panel.is-open,.log-panel.is-open,.general-info-modal,.resume-overlay,.result-wrap,.result-player';
const OVERLAY_SEL = '.reveal-box,.judge-overlay,.pindian-overlay,.rescue-banner,.hand-reveal,.wugu-tray,.chain-layer,.flow-layer,.fx-layer,#resume-overlay';

function args() {
  const out = {};
  process.argv.slice(2).forEach(a => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) return;
    out[m[1]] = m[2] == null ? true : m[2];
  });
  return out;
}
const A = args();
const full = !A.viewport && !A.scene;
const onlyVp = A.viewport ? VIEWPORTS.filter(v => v.id === A.viewport || String(v.width) === A.viewport) : VIEWPORTS;
const onlyScene = A.scene && A.scene !== 'all' ? String(A.scene).split(',') : null;

function ensureDirs() {
  fs.mkdirSync(OUT, { recursive: true });
  if (full) {
    if (fs.existsSync(LATEST)) {
      if (fs.existsSync(PREV)) fs.rmSync(PREV, { recursive: true, force: true });
      fs.renameSync(LATEST, PREV);
    }
    fs.mkdirSync(LATEST, { recursive: true });
  } else {
    fs.mkdirSync(LATEST, { recursive: true });
  }
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch (e) { /* Chrome may still hold profile */ }
}
function readWhitelist() {
  try { return JSON.parse(fs.readFileSync(WHITE, 'utf8')); } catch (e) { return []; }
}
function cssPath(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return '#' + el.id;
  let parts = [];
  let n = el;
  while (n && n.nodeType === 1 && parts.length < 7) {
    let s = n.tagName.toLowerCase();
    if (n.className && typeof n.className === 'string') {
      const c = n.className.trim().split(/\s+/).slice(0, 2).map(x => '.' + x.replace(/[^\w-]/g, '')).join('');
      s += c;
    }
    const parent = n.parentElement;
    if (parent) {
      const same = Array.prototype.filter.call(parent.children, x => x.tagName === n.tagName);
      if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
    }
    parts.unshift(s);
    n = parent;
  }
  return parts.join(' > ');
}

async function main() {
  ensureDirs();
  const whitelist = readWhitelist();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: PROFILE,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hidden-scrollbars', '--force-device-scale-factor=1'],
  });
  let page = await browser.newPage();
  page.on('pageerror', e => console.error('PAGEERROR', e.message));
  let report = { generated: new Date().toISOString(), viewports: [], issues: [], notes: [] };
  if (!full) {
    try {
      const old = JSON.parse(fs.readFileSync(path.join(LATEST, 'layout-report.json'), 'utf8'));
      if (old && Array.isArray(old.issues) && Array.isArray(old.viewports)) {
        const ids = new Set(onlyVp.map(v => v.id));
        report = {
          generated: new Date().toISOString(),
          viewports: old.viewports.filter(v => !ids.has(v.id)),
          issues: old.issues.filter(i => !ids.has(i.viewport)),
          notes: (old.notes || []).filter(n => !ids.has(n.viewport)),
        };
      }
    } catch (e) { /* first incremental run */ }
  }
  let shotIndex = 0;
  for (const vp of onlyVp) {
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: vp.width < 800, hasTouch: vp.width < 800 });
    // 尝试 safe-area；Chrome 不支持时记录，不影响检查。
    let safeOK = false;
    try {
      const cdp = await page.createCDPSession();
      await cdp.send('Emulation.setSafeAreaInsets', { insets: { top: 24, left: 0, right: 0, bottom: 20 } });
      safeOK = true;
      await cdp.detach();
    } catch (e) { report.notes.push({ viewport: vp.id, note: 'Emulation.setSafeAreaInsets unsupported: ' + e.message }); }
    const vpres = { id: vp.id, width: vp.width, height: vp.height, safeArea: safeOK, scenes: [], p0: 0, p1: 0, p2: 0 };
    let vpShot = false;
    const modes = FULL_MODES.concat(MINI_MODES);
    for (const mode of modes) {
      const scenes = FULL_MODES.includes(mode) ? FULL_SCENES : MINI_SCENES;
      for (const scene of scenes) {
        if (onlyScene && !onlyScene.includes(scene)) continue;
        let one;
        try {
          one = await runScene(page, vp, mode, scene, whitelist);
        } catch (e) {
          report.notes.push({ viewport: vp.id, mode, scene, note: 'scene error: ' + e.message });
          if (/detached|Target closed|Session closed/i.test(e.message)) {
            try {
              await page.close().catch(() => {});
              page = await browser.newPage();
              page.on('pageerror', err => console.error('PAGEERROR', err.message));
              await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1, isMobile: vp.width < 800, hasTouch: vp.width < 800 });
              one = await runScene(page, vp, mode, scene, whitelist);
            } catch (e2) {
              report.notes.push({ viewport: vp.id, mode, scene, note: 'scene skipped after retry: ' + e2.message });
              one = { issues: [{ level: 'P1', type: '场景执行失败', selector: '', measure: e2.message, rect: null }] };
            }
          } else {
            report.notes.push({ viewport: vp.id, mode, scene, note: 'scene skipped: ' + e.message });
            one = { issues: [{ level: 'P1', type: '场景执行失败', selector: '', measure: e.message, rect: null }] };
          }
        }
        vpres.scenes.push({ mode, scene, count: one.issues.length, p0: one.issues.filter(x => x.level === 'P0').length, p1: one.issues.filter(x => x.level === 'P1').length, p2: one.issues.filter(x => x.level === 'P2').length });
        one.issues.forEach(i => { i.viewport = vp.id; i.mode = mode; i.scene = scene; report.issues.push(i); });
        if (!vpShot && !A['no-shot']) {
          try {
            await page.screenshot({ path: path.join(LATEST, `full_${vp.id}.jpg`), type: 'jpeg', quality: 70, fullPage: false });
            vpShot = true;
          } catch (e) { report.notes.push({ viewport: vp.id, note: 'screenshot failed: ' + e.message }); }
        }
        for (const it of one.issues.filter(x => x.level === 'P0' || x.level === 'P1')) {
          if (A['no-shot'] || !it.rect) continue;
          const clip = { x: Math.max(0, it.rect.left - 40), y: Math.max(0, it.rect.top - 40), width: Math.min(vp.width, it.rect.width + 80), height: Math.min(vp.height, it.rect.height + 80) };
          if (clip.width < 1 || clip.height < 1) continue;
          const f = path.join(LATEST, `issue_${vp.id}_${++shotIndex}.jpg`);
          try { await page.screenshot({ path: f, type: 'jpeg', quality: 70, clip }); it.screenshot = path.relative(ROOT, f); } catch (e) { /* ignore */ }
        }
      }
    }
    vpres.p0 = report.issues.filter(x => x.viewport === vp.id && x.level === 'P0').length;
    vpres.p1 = report.issues.filter(x => x.viewport === vp.id && x.level === 'P1').length;
    vpres.p2 = report.issues.filter(x => x.viewport === vp.id && x.level === 'P2').length;
    report.viewports.push(vpres);
    console.log('VIEWPORT', vp.id, 'P0=' + vpres.p0, 'P1=' + vpres.p1, 'P2=' + vpres.p2);
  }
  // 同一选择器/级别/类型在不同场景重复命中只保留一条，附 scenes/count；报告体积与验收口径都以去重后为准。
  const rawIssues = report.issues;
  const groups = new Map();
  rawIssues.forEach(i => {
    const key = [i.level, i.type, i.viewport, i.selector].join('||');
    if (!groups.has(key)) groups.set(key, Object.assign({}, i, { scenes: [], count: 0, measures: [] }));
    const g = groups.get(key);
    if (g.scenes.indexOf(i.scene) < 0) g.scenes.push(i.scene);
    if (i.mode && g.scenes.indexOf(i.mode + '/' + i.scene) < 0) g.scenes.push(i.mode + '/' + i.scene);
    g.count += 1;
    if (g.measures.length < 3 && g.measures.indexOf(i.measure) < 0) g.measures.push(i.measure);
  });
  report.rawCount = rawIssues.length;
  report.issues = Array.from(groups.values());
  for (const vp of report.viewports) {
    vp.p0 = report.issues.filter(i => i.viewport === vp.id && i.level === 'P0').length;
    vp.p1 = report.issues.filter(i => i.viewport === vp.id && i.level === 'P1').length;
    vp.p2 = report.issues.filter(i => i.viewport === vp.id && i.level === 'P2').length;
  }
  const outFile = path.join(LATEST, 'layout-report.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  await browser.close();
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch (e) { /* Chrome may still hold profile */ }
  const bad = report.issues.filter(x => x.level === 'P0' || x.level === 'P1');
  console.log('SUMMARY', JSON.stringify({ viewports: report.viewports.map(v => ({ id: v.id, P0: v.p0, P1: v.p1, P2: v.p2 })), P0: bad.filter(x => x.level === 'P0').length, P1: bad.filter(x => x.level === 'P1').length, P2: report.issues.filter(x => x.level === 'P2').length }));
  console.log('REPORT', path.relative(ROOT, outFile));
  if (bad.length) {
    console.log('FIRST_ISSUES', '(deduped ' + bad.length + ' / raw ' + report.rawCount + ')');
    const list = A.explain ? bad : bad.slice(0, 80);
    list.forEach(i => console.log(i.level, i.type, i.viewport, i.mode, i.scene, i.selector, i.measure, i.text ? ('| ' + i.text.slice(0, 60)) : ''));
    process.exitCode = 1;
  } else {
    console.log('NO_P0_P1', 'raw=' + report.rawCount);
  }
}

async function runScene(page, vp, mode, scene, whitelist) {
  const url = BASE + '?nofx=1&demo=1&freeze=play&seed=20261116&speed=0&mode=' + mode;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => {
    const s = window.SGS_UI && SGS_UI._state && SGS_UI._state();
    return !!(s && s.game && s.game.players && s.game.players.length);
  }, { timeout: 15000 });
  try {
    await page.waitForFunction(() => {
      const s = SGS_UI._state();
      return !!(s.pending && s.pending.req && s.pending.req.type === 'play');
    }, { timeout: 12000 });
  } catch (e) {
    // 某些模式启动/演示冻结会错过 play 请求；用 UI 公开请求强制进入出牌态，仅测试布局。
    await page.evaluate(() => {
      const s = SGS_UI._state(); const g = s.game;
      if (g && g.players && g.players[0]) SGS_UI.request({ type: 'play', player: g.players[0], actions: [], reason: '布局检查冻结' }, () => {});
    });
    await sleep(250);
  }
  await sleep(150);
  await page.evaluate(async (o) => {
    const scene = o.scene;
    const g = SGS_UI._state().game;
    const p = g.players[0];
    const D = window.SGS_DATA || {};
    const CARDS = D.CARDS || {};
    const SKILLS = D.SKILLS || {};
    let seq = 900000;
    function C(name, suit, rank) {
      const def = Object.keys(CARDS).find(k => CARDS[k].name === name) || name;
      const d = CARDS[def] || {};
      return { id: seq++, name: def, suit: suit || 'spade', rank: rank || 1, type: d.type, subtype: d.subtype || null, range: d.range || 0, color: (suit === 'heart' || suit === 'diamond') ? 'red' : 'black' };
    }
    function setHand(n) {
      const cards = [];
      const pool = (g.deck || []).slice(0, n);
      while (cards.length < n) {
        const c = pool[cards.length] || (p.hand && p.hand[cards.length]) || { name: 'sha', suit: 'spade', rank: 1 };
        cards.push(Object.assign({}, c, { id: 800000 + cards.length }));
      }
      p.hand = cards;
    }
    function longName() {
      const arr = Object.keys(D.GENERALS || {}).map(k => D.GENERALS[k].name).filter(Boolean);
      return arr.sort((a, b) => b.length - a.length)[0] || '卧龙诸葛亮';
    }
    const longSkill = Object.keys(SKILLS).sort((a, b) => ((SKILLS[b].desc || '').length - (SKILLS[a].desc || '').length))[0] || 'j_yijue';
    p.general = p.general || {};
    p.general.name = longName();
    p.name = p.general.name;
    p.general.skills = [longSkill];
    p.skills = [longSkill];
    let n = scene === 'play1' ? 1 : scene === 'play10' ? 10 : scene === 'play15' ? 15 : 5;
    setHand(n);
    p.equips = {
      weapon: C('qinggang', 'spade', 6), armor: C('bagua', 'spade', 2),
      offhorse: C('chitu', 'heart', 5), defhorse: C('dilu', 'club', 5),
    };
    p.judges = [C('lebu', 'spade', 3), C('bingliang', 'club', 4)];
    p.hp = Math.max(1, p.maxHp || 4);
    SGS_UI.render(g);
    if (scene === 'target') {
      SGS_UI.request({ type: 'chooseTargets', player: p, candidates: g.players.map(x => x.seat), min: 1, max: 2, reason: '请选择至多两名角色（布局检查）' }, () => {});
    } else if (scene === 'wugu') {
      g.log('【五谷丰登】亮出：【桃】♥3、【杀】♠7、【闪】♦9、【无懈可击】♣4、【决斗】♥K', 'info'); g.emit();
    } else if (scene === 'rescue') {
      g.recent = g.recent || [];
      g.recent.push({ kind: 'rescue', seat: 1, dyingSeat: 0, phase: 'ask' });
      SGS_UI.render(g);
    } else if (scene === 'pindian') {
      g.recent = g.recent || [];
      g.recent.push({ kind: 'pindian', reason: '拼点检查', tie: false, win: true,
        a: { name: '刘备', card: { name: 'sha', suit: 'spade', rank: 7 } },
        b: { name: '曹操', card: { name: 'shan', suit: 'heart', rank: 9 } } });
      SGS_UI.render(g);
    } else if (scene === 'hidden') {
      SGS_UI.request({ type: 'chooseHiddenCard', player: p, target: g.players[1], count: 2, reason: '暗手牌检查：选择一张手牌' }, () => {});
    } else if (scene === 'judge') {
      g.log('你（' + (p.general.name || '角色') + '） 判定（八卦阵）：【桃】♦2', 'judge'); g.emit();
    } else if (scene === 'intro') {
      const el = document.querySelector('.seat[data-seat="3"]') || document.querySelector('.seat');
      if (el) {
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7, pointerType: 'touch', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
        await new Promise(r2 => setTimeout(r2, 580));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, pointerType: 'touch' }));
        const info = document.querySelector('[data-gi-info]');
        if (info) info.click();
      }
    } else if (scene === 'skilldesc') {
      const portrait = document.querySelector('#me-portrait');
      if (portrait) portrait.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    }
    await new Promise(r => setTimeout(r, 260));
    if (scene === 'log') document.querySelector('#btn-log') && document.querySelector('#btn-log').click();
    if (scene === 'settings' || scene === 'pause') {
      document.querySelector('#btn-settings') && document.querySelector('#btn-settings').click();
      await new Promise(r => setTimeout(r, 80));
      if (scene === 'pause') document.querySelector('#btn-pause-game') && document.querySelector('#btn-pause-game').click();
    }
  }, { scene, mode });

  await sleep(scene === 'pause' ? 900 : 350);
  // 动画残留检查前等待 2s；不作用于交互场景的即时检查
  if (scene === 'play5' || scene === 'target' || scene === 'wugu' || scene === 'judge') await sleep(2100);
  const found = await page.evaluate(auditPage, { whitelist, keySel: SELECTOR_KEY, textSel: SELECTOR_TEXT, clickSel: SELECTOR_INTERACTIVE, overlaySel: OVERLAY_SEL, scene, vp: { width: vp.width, height: vp.height } });
  return found;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* 页面内审计，必须在页面上下文执行；不要引用 Node。 */
function auditPage(opts) {
  const issues = [];
  const vw = innerWidth, vh = innerHeight;
  const W = opts.whitelist || [];
  function add(level, type, selector, measure, extra) {
    issues.push(Object.assign({ level, type, selector: selector || '', measure: measure || '', rect: null }, extra || {}));
  }
  function visible(e) {
    if (!e || !e.getBoundingClientRect) return false;
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    if (e.closest && e.closest('.settings-panel:not(.is-open),.log-panel:not(.is-open),.modal-root:empty,.general-info-root:empty')) return false;
    if (e.matches && e.matches('.judge-overlay:not(.is-on),.hand-reveal:not(.is-on),.pindian-overlay:not(.is-on),.reveal-box:not(.is-on),.wugu-tray:not(.is-on),.rescue-banner:not(.is-on)')) return false;
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0.01 && r.width > 1 && r.height > 1;
  }
  function rect(e) { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }
  function pathOf(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + el.id;
    const parts = []; let n = el;
    while (n && n.nodeType === 1 && parts.length < 7) {
      let s = n.tagName.toLowerCase();
      if (n.className && typeof n.className === 'string') {
        const cs = n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(x => '.' + x.replace(/[^\w-]/g, ''));
        s += cs.join('');
      }
      const par = n.parentElement;
      if (par) { const same = Array.prototype.filter.call(par.children, x => x.tagName === n.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')'; }
      parts.unshift(s); n = par;
    }
    return parts.join(' > ');
  }
  function intersects(a, b) { return a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1; }
  function zOf(el) { try { return getComputedStyle(el).zIndex; } catch (e) { return ''; } }
  function isWhitelist(a, b, parent) {
    return W.some(w => {
      const pp = w.parent || ''; const aa = w.a || ''; const bb = w.b || '';
      const pm = !pp || (parent && parent.matches && parent.matches(pp));
      const am = !aa || (a.matches && a.matches(aa));
      const bm = !bb || bb === '*' || (b.matches && b.matches(bb));
      return pm && ((am && bm) || (w.symmetric && !am && b.matches && b.matches(aa)));
    });
  }
  // 顶层上下文：模态/抽屉/中央浮层打开时，背景座位被遮盖是预期，只查顶层
  const pauseOpen = Array.from(document.querySelectorAll('.resume-overlay.is-on')).some(visible);
  const modalOpen = Array.from(document.querySelectorAll('.modal-mask')).some(visible);
  const drawerOpen = Array.from(document.querySelectorAll('.settings-panel.is-open,.log-panel.is-open')).some(visible);
  const overlayOpen = Array.from(document.querySelectorAll('.wugu-tray.is-on,.judge-overlay.is-on,.pindian-overlay.is-on,.rescue-banner.is-on,.hand-reveal.is-on,.reveal-box.is-on')).some(visible);
  const context = pauseOpen ? 'pause' : modalOpen ? 'modal' : drawerOpen ? 'drawer' : overlayOpen ? 'overlay' : 'game';
  function inContext(el) {
    if (context === 'pause') return !!(el.closest && el.closest('.resume-overlay'));
    if (context === 'modal') return !!(el.closest && el.closest('.modal'));
    if (context === 'drawer') return !!(el.closest && el.closest('.settings-panel,.log-panel'));
    if (context === 'overlay') {
      if (el.closest && el.closest('.wugu-tray,.judge-overlay,.pindian-overlay,.rescue-banner,.hand-reveal,.reveal-box')) return true;
      return !!(el.matches && el.matches('.topbar,.hand,.hand-wrap,.action-bar,.human,.human-left,.human-mid,.human-right'));
    }
    return true;
  }
  // 场景会用到的浮层才纳入检查；避免初始隐藏层干扰
  function overlayAllowed(el) {
    if (el.matches('.resume-overlay')) return opts.scene === 'pause';
    if (el.matches('.judge-overlay')) return opts.scene === 'judge';
    if (el.matches('.wugu-tray')) return opts.scene === 'wugu';
    if (el.matches('.pindian-overlay')) return opts.scene === 'pindian';
    if (el.matches('.rescue-banner')) return opts.scene === 'rescue';
    if (el.matches('.hand-reveal,.reveal-box')) return opts.scene === 'hidden' || opts.scene === 'wugu' || opts.scene === 'judge';
    if (el.matches('.settings-panel')) return opts.scene === 'settings' || opts.scene === 'pause';
    if (el.matches('.log-panel')) return opts.scene === 'log';
    return true;
  }
  // 1) 关键元素越界/遮挡/尺寸/字号/截断
  const key = Array.from(document.querySelectorAll(opts.keySel)).filter(e => visible(e) && overlayAllowed(e) && inContext(e));
  key.forEach(e => {
    const r = rect(e), c = getComputedStyle(e);
    const outX = r.left < -2 || r.right > vw + 2;
    const outY = r.top < -2 || r.bottom > vh + 2;
    if (outX || outY) {
      const lvl = /button|\.btn|\.tb-btn|\.modal|\.result-player/.test((e.className || '') + ' ' + e.tagName) ? 'P0' : 'P1';
      add(lvl, '越界', pathOf(e), `rect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)} vp=${vw}x${vh}`);
      issues[issues.length - 1].rect = r;
    }
    if (r.width < 44 || r.height < 44) {
      if (e.matches(opts.clickSel) && /button|\.btn|\.tb-btn|\.hand-card|\.seat|\.skill-btn|\.equip-slot/.test((e.className || '') + ' ' + e.tagName)) {
        add('P2', '点击区<44', pathOf(e), `${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    const fs = parseFloat(c.fontSize);
    if (fs && fs < 12 && e.innerText && e.innerText.trim()) add('P2', '字号<12', pathOf(e), `font=${fs}px`);
    // title/ellipsis/clipped text
    const txt = (e.innerText || '').trim();
    const clipped = e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1;
    const eff = c.overflow + ' ' + c.textOverflow + ' ' + c.webkitLineClamp;
    if (txt && clipped && (c.overflow === 'hidden' || c.textOverflow === 'ellipsis' || c.webkitLineClamp !== 'none')) {
      add('P1', '文字截断', pathOf(e), `scroll=${e.scrollWidth}x${e.scrollHeight} client=${e.clientWidth}x${e.clientHeight} ${eff}`, { text: txt });
    }
    // 文字越出父框（只对文本叶子/直接文本节点，容器不计）
    const leafText = e.matches(opts.textSel) && (e.children.length === 0 || /^(SPAN|B|EM|SMALL|BUTTON|P|I)$/.test(e.tagName));
    const pe = e.parentElement;
    if (leafText && pe && visible(pe)) {
      const pr = rect(pe);
      if (r.left < pr.left - 4 || r.right > pr.right + 4 || r.top < pr.top - 4 || r.bottom > pr.bottom + 4) {
        if (txt) add('P1', '文字越界', pathOf(e), `child=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)} parent=${Math.round(pr.left)},${Math.round(pr.top)},${Math.round(pr.right)},${Math.round(pr.bottom)}`, { text: txt });
      }
    }
    // 非交互展示层 pointer-events:none 会穿透，不能作为遮挡问题
    if (getComputedStyle(e).pointerEvents === 'none') return;
    // elementFromPoint center + corners；浮层/抽屉容器有透明边角，只检查中心
    const isOverlayBox = e.matches('.wugu-tray,.judge-overlay,.pindian-overlay,.rescue-banner,.hand-reveal,.reveal-box,.log-panel,.settings-panel,.modal,.modal-mask,.resume-overlay');
    const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]];
    pts.forEach((pt, i) => {
      if (isOverlayBox && i > 0) return;
      const x = Math.max(0, Math.min(vw - 1, pt[0])), y = Math.max(0, Math.min(vh - 1, pt[1]));
      const top = document.elementFromPoint(x, y);
      if (!top) return;
      const pass = top === e || e.contains(top) || top.contains(e) || (e.matches('.hand-card') && top.closest && top.closest('.hand'));
      if (!pass) add('P1', '遮挡', pathOf(e), `pt${i}=${Math.round(x)},${Math.round(y)} top=${pathOf(top)} z=${zOf(top)}`);
    });
    // image checks
    if (e.tagName === 'IMG') {
      if (!e.complete || e.naturalWidth === 0) add('P1', '图片加载失败', pathOf(e), `natural=${e.naturalWidth}x${e.naturalHeight}`, { rect: r });
      else {
        const ratio = e.naturalWidth / e.naturalHeight, br = (r.width / r.height);
        const fit = getComputedStyle(e).objectFit;
        if (Math.abs(ratio - br) / ratio > 0.05 && (!fit || fit === 'fill')) add('P1', '图片拉伸', pathOf(e), `natural=${ratio.toFixed(2)} box=${br.toFixed(2)} fit=${fit}`);
        if (fit === 'cover') add('P2', 'cover裁切待验证', pathOf(e), `natural=${e.naturalWidth}x${e.naturalHeight} box=${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
  });
  // 2) 外框重叠
  function boxes(sel) { return Array.from(document.querySelectorAll(sel)).filter(visible).map(e => ({ e, r: rect(e) })); }
  const seats = context === 'overlay' || context === 'modal' || context === 'drawer' ? [] : boxes('.seat');
  const centers = context === 'overlay' || context === 'modal' || context === 'drawer' ? [] : boxes('.table-center,.played-cards,.phase-orbit');
  seats.forEach(s => centers.forEach(c => { if (intersects(s.r, c.r)) add('P1', '外框重叠', pathOf(s.e), 'seat∩' + pathOf(c.e) + ' area'); }));
  const hand = context === 'game' ? boxes('.hand,.hand-wrap') : [];
  const bars = context === 'game' ? boxes('.action-bar,.tb-right,.pick-bar') : [];
  hand.forEach(h => bars.forEach(b => { if (intersects(h.r, b.r)) add('P1', '外框重叠', pathOf(h.e), 'hand∩' + pathOf(b.e)); }));
  const topbar = boxes('.topbar');
  topbar.forEach(t => seats.forEach(s => { if (intersects(t.r, s.r)) add('P0', '外框重叠', pathOf(s.e), 'seat∩topbar'); }));
  // 3) 座位内部子元素重叠（白名单）
  seats.forEach(s => {
    const kids = Array.from(s.e.querySelectorAll('.seat-kingdom,.seat-role,.seat-name,.seat-hand,.seat-hp,.seat-equip-list,.seat-distance,.seat-art,.seat-frame,.seat-veil,.seat-mid,.seat-badges')).filter(visible);
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i], b = kids[j];
      const ar = rect(a), br = rect(b);
      if (intersects(ar, br) && !isWhitelist(a, b, s.e)) add('P2', '座位内子元素重叠', pathOf(a), pathOf(b), { text: 'parent=' + pathOf(s.e) });
    }
  });
  // 4) 动画残留 / 浮层
  const overlays = Array.from(document.querySelectorAll(opts.overlaySel)).filter(e => visible(e) && overlayAllowed(e));
  overlays.forEach(e => { const c = getComputedStyle(e); if (c.pointerEvents !== 'none') add('P2', '动画/浮层残留', pathOf(e), 'pointer=' + c.pointerEvents + ' opacity=' + c.opacity); });
  // 4b) 图片（所有可见图片）
  Array.from(document.querySelectorAll('img')).filter(e => visible(e) && inContext(e)).forEach(img => {
    const r = rect(img);
    if (!img.complete || img.naturalWidth === 0) add('P1', '图片加载失败', pathOf(img), `natural=${img.naturalWidth}x${img.naturalHeight}`, { rect: r });
    else {
      const ratio = img.naturalWidth / img.naturalHeight, box = r.width / Math.max(1, r.height);
      const fit = getComputedStyle(img).objectFit;
      if (Math.abs(ratio - box) / ratio > 0.05 && (!fit || fit === 'fill')) add('P1', '图片拉伸', pathOf(img), `natural=${ratio.toFixed(2)} box=${box.toFixed(2)} fit=${fit}`, { rect: r });
      if (fit === 'cover') add('P2', 'cover裁切待验证', pathOf(img), `${img.naturalWidth}x${img.naturalHeight} box=${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  });
  // 5) 字体/拼音
  if (document.fonts && document.fonts.status !== 'loaded') add('P2', '字体未就绪', 'document.fonts', document.fonts.status);
  const texts = Array.from(document.querySelectorAll(opts.textSel)).filter(e => visible(e) && inContext(e));
  const py = /^(sha|shan|tao|guohe|wuxie|juedou|wugu|lebu|bingliang|shandian|jiedao|tiesuo|huogong|shunshou)(\b|$)/i;
  texts.forEach(e => { const t = (e.innerText || '').trim(); if (t && py.test(t) && !/[\u4e00-\u9fa5]/.test(t)) add('P1', '纯拼音文案', pathOf(e), t.slice(0, 30)); });
  // 6) 文本压图对比度粗检：背景色/图片下无法可靠采样，记录待验证
  texts.forEach(e => {
    const c = getComputedStyle(e);
    let p = e.parentElement, overImg = false;
    while (p && p !== document.body) { if (p.tagName === 'IMG' || (p.querySelector && p.querySelector('img'))) { overImg = true; break; } p = p.parentElement; }
    if (overImg && c.color) add('P2', '文字压图对比度待验证', pathOf(e), 'color=' + c.color);
  });
  return { issues };
}

main().catch(async e => { console.error('FATAL', e && e.stack || e); process.exit(2); });
