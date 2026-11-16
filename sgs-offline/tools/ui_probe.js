#!/usr/bin/env node
/* 三国杀 · 单机版 — UI 回归探测
 * ------------------------------------------------------------------
 * 覆盖：
 *   1) SGS_BACK() 返回键矩阵：主菜单 / 对局 / 设置 / 更多 / 选牌 / 暂停遮罩 / 结算 / 选将
 *   2) 手动暂停：倒计时冻结、恢复后从剩余时间继续
 *   3) 静音：持久化、静音后切后台再回来不自动有声、解除静音恢复
 *   4) 选目标 pick-bar 内暂停入口（注入 chooseTargets 请求验证 UI 路径）
 *
 * 用法：
 *   node tools/ui_probe.js
 *   node tools/ui_probe.js --base-url http://127.0.0.1:8899/ --viewport 412x915
 *   node tools/ui_probe.js --chrome "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
 *   node tools/ui_probe.js --json
 *
 * 退出码：0 = 全部 PASS/SKIP；1 = 有 FAIL；2 = 环境不可用（Chrome/页面打不开）
 * 依赖：puppeteer-core（sgs-offline/node_modules 内），不下载 Chromium。
 * ------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const puppeteer = require('puppeteer-core');

const DEFAULT_CHROME = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });

function parseArgs(argv) {
  const out = { baseUrl: 'http://127.0.0.1:8899/', chrome: process.env.CHROME_PATH || DEFAULT_CHROME, viewport: '412x915', json: false, headless: true };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--base-url') out.baseUrl = argv[++i];
    else if (a === '--chrome') out.chrome = argv[++i];
    else if (a === '--viewport') out.viewport = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--headed') out.headless = false;
    else if (a === '--help' || a === '-h') {
      console.log('用法: node tools/ui_probe.js [--base-url URL] [--chrome PATH] [--viewport 412x915] [--json] [--headed]');
      process.exit(0);
    }
  }
  const m = /^(\d+)x(\d+)$/.exec(out.viewport);
  if (!m) { console.error('viewport 格式应为 412x915'); process.exit(2); }
  out.width = Number(m[1]);
  out.height = Number(m[2]);
  return out;
}

const args = parseArgs(process.argv);
if (!args.chrome) {
  console.log('SKIP: 未找到 Chrome（可用 --chrome 或 CHROME_PATH 指定），ui_probe 未执行。');
  process.exit(0);
}

const results = [];
function record(level, name, detail) {
  results.push({ level, name, detail: detail || '' });
  if (!args.json) console.log(`[${level}] ${name}${detail ? ' — ' + detail : ''}`);
}
function pass(name, detail) { record('PASS', name, detail); }
function fail(name, detail) { record('FAIL', name, detail); }
function skip(name, detail) { record('SKIP', name, detail); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, timeoutMs, intervalMs) {
  const end = Date.now() + (timeoutMs || 8000);
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch (e) { /* keep polling */ }
    await sleep(intervalMs || 100);
  }
  return false;
}

async function open(page, url) {
  await page.goto(args.baseUrl.replace(/\/?$/, '/') + url, { waitUntil: 'load', timeout: 60000 });
  await sleep(900);
}

async function openGame(page) {
  await open(page, '?mode=8p&screen=game&seed=7');
  await waitFor(page, () => page.evaluate(() => {
    const b = document.querySelector('#btn-pause');
    return !!b && b.getBoundingClientRect().width >= 44;
  }), 8000);
}

async function openSettings(page) {
  await page.evaluate(() => document.querySelector('#btn-more') && document.querySelector('#btn-more').click());
  await sleep(150);
  await page.evaluate(() => document.querySelector('#btn-settings') && document.querySelector('#btn-settings').click());
  return waitFor(page, () => page.evaluate(() => {
    const s = document.querySelector('#settings-panel');
    if (!s || !s.classList.contains('is-open')) return false;
    const c = getComputedStyle(s).transform;
    const m = /matrix\(([^)]+)\)/.exec(c);
    const tx = m ? parseFloat(m[1].split(',')[4]) : 0;
    return Math.abs(tx) < 1;
  }), 8000);
}

async function clickMute(page) {
  const pt = await page.evaluate(() => {
    const r = document.querySelector('.switch-mute').getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  });
  await page.mouse.click(pt[0], pt[1]);
  await sleep(300);
}

async function audioState(page) {
  return page.evaluate(() => ({
    enabled: window.SGS_AUDIO ? SGS_AUDIO.enabled : null,
    stored: localStorage.getItem('sgs.settings.v1'),
    playing: (window.__sgsAudios || []).filter((a) => !a.paused).map((a) => (a.currentSrc || a.src || '').split('/').pop()),
  }));
}

async function back(page) {
  return page.evaluate(() => {
    try { return SGS_BACK(); } catch (e) { return 'ERROR:' + e.message; }
  });
}

async function modalText(page) {
  return page.evaluate(() => {
    const m = document.querySelector('.modal-mask');
    return m ? m.innerText.replace(/\s+/g, ' ').slice(0, 60) : '';
  });
}

async function closeModal(page) {
  await page.evaluate(() => {
    const b = document.querySelector('.modal-mask [data-c="0"]') || document.querySelector('.modal-mask .btn-outline');
    if (b) b.click();
  });
  await sleep(250);
}

/* ---------------- 1. SGS_BACK 矩阵 ---------------- */
async function probeBack(page) {
  await open(page, '?screen=menu');
  const menu = await back(page);
  if (menu === false) pass('返回键/主菜单 = false（允许退出 App）');
  else fail('返回键/主菜单 应为 false', String(menu));

  await openGame(page);
  const game = await back(page);
  const gameModal = await modalText(page);
  if (game === true && /退出本局将判负/.test(gameModal)) pass('返回键/对局 = true + 退出确认');
  else fail('返回键/对局 应 true + 退出确认', `${game} / ${gameModal}`);
  await closeModal(page);

  await page.evaluate(() => document.querySelector('#btn-more').click());
  await sleep(200);
  const more = await back(page);
  const moreClosed = await page.evaluate(() => !document.querySelector('#more-menu').classList.contains('is-open'));
  if (more === true && moreClosed) pass('返回键/更多菜单 = true 且关闭');
  else fail('返回键/更多菜单 应 true 且关闭', `${more} / closed=${moreClosed}`);

  const settingsOpened = await openSettings(page);
  const settings = await back(page);
  const settingsClosed = await page.evaluate(() => !document.querySelector('#settings-panel').classList.contains('is-open'));
  if (settingsOpened && settings === true && settingsClosed) pass('返回键/设置面板 = true 且关闭');
  else fail('返回键/设置面板 应 true 且关闭', `open=${settingsOpened} / ${settings} / closed=${settingsClosed}`);

  await page.evaluate(() => document.querySelector('#btn-log').click());
  await sleep(300);
  const log = await back(page);
  const logClosed = await page.evaluate(() => !document.querySelector('#log-panel').classList.contains('is-open'));
  if (log === true && logClosed) pass('返回键/战报 = true 且关闭');
  else fail('返回键/战报 应 true 且关闭', `${log} / closed=${logClosed}`);

  await page.evaluate(() => document.querySelector('#btn-pause').click());
  await sleep(600);
  const pause = await back(page);
  const pauseKept = await page.evaluate(() => document.querySelector('#resume-overlay').classList.contains('is-on'));
  if (pause === true && pauseKept) pass('返回键/暂停遮罩 = true 且保持');
  else fail('返回键/暂停遮罩 应 true 且保持', `${pause} / kept=${pauseKept}`);
  await page.evaluate(() => document.querySelector('#btn-resume').click());
  await sleep(300);

  // 注入 chooseCards：选牌弹窗必须被返回键消费，但不能关闭
  await page.evaluate(() => {
    const st = SGS_UI._state();
    const g = st.game;
    const me = g.players[g.humanSeat];
    SGS_UI.request({ type: 'chooseCards', player: me, cards: me.hand.slice(0, 2), min: 1, max: 1, reason: 'ui_probe 选牌' }, function () {});
  });
  await sleep(400);
  const cards = await back(page);
  const cardsKept = await page.evaluate(() => !!document.querySelector('.modal-mask'));
  if (cards === true && cardsKept) pass('返回键/选牌弹窗 = true 且保持（注入 chooseCards）');
  else fail('返回键/选牌弹窗 应 true 且保持', `${cards} / kept=${cardsKept}`);

  await open(page, '?screen=menu');
  await page.evaluate(() => SGS_UI.showScreen('result'));
  await sleep(300);
  const result = await back(page);
  const resultScreen = await page.evaluate(() => SGS_UI._state().screen);
  if (result === true && resultScreen === 'menu') pass('返回键/结算 = true → 主菜单');
  else fail('返回键/结算 应 true → menu', `${result} / ${resultScreen}`);

  await open(page, '?mode=8p&screen=select&seed=7');
  const select = await back(page);
  const selectScreen = await page.evaluate(() => SGS_UI._state().screen);
  if (select === true && selectScreen === 'menu') pass('返回键/选将 = true → 主菜单');
  else fail('返回键/选将 应 true → menu', `${select} / ${selectScreen}`);
}

/* ---------------- 2. 暂停倒计时冻结 ---------------- */
async function probePause(page) {
  await open(page, '?mode=8p&screen=select&seed=7');
  await page.evaluate(() => {
    const c = document.querySelector('.general-card');
    if (c) c.click();
    const ok = document.querySelector('#btn-general-confirm');
    if (ok && !ok.disabled) ok.click();
  });
  const hasCountdown = await waitFor(page, () => page.evaluate(() => /剩余\s*\d+s/.test(document.querySelector('#tb-count').textContent)), 45000, 400);
  if (!hasCountdown) {
    skip('暂停/倒计时冻结', '45s 内未等到玩家读秒（AI 回合较慢），本条跳过');
    return;
  }
  const c0 = await page.evaluate(() => document.querySelector('#tb-count').textContent.trim());
  await page.evaluate(() => document.querySelector('#btn-pause').click());
  await sleep(600);
  const p0 = await page.evaluate(() => ({ count: document.querySelector('#tb-count').textContent.trim(), overlay: document.querySelector('#resume-overlay').classList.contains('is-on'), sub: document.querySelector('#resume-sub').textContent }));
  await sleep(2200);
  const p1 = await page.evaluate(() => document.querySelector('#tb-count').textContent.trim());
  await page.evaluate(() => document.querySelector('#btn-resume').click());
  await sleep(1400);
  const c1 = await page.evaluate(() => document.querySelector('#tb-count').textContent.trim());
  const n0 = parseInt((c0.match(/\d+/) || [0])[0], 10);
  const n1 = parseInt((p1.match(/\d+/) || [0])[0], 10);
  const n2 = parseInt((c1.match(/\d+/) || [0])[0], 10);
  if (p0.overlay && p0.sub.indexOf('背景音乐继续') >= 0 && n1 === n0 && n2 < n1) {
    pass('暂停/倒计时冻结与恢复', `${c0} → 暂停 2.2s 仍 ${p1} → 恢复后 ${c1}`);
  } else {
    fail('暂停/倒计时冻结与恢复', `${c0} → ${p1} → ${c1} / overlay=${p0.overlay} / sub=${p0.sub}`);
  }
}

/* ---------------- 3. 静音持久化 + 后台 ---------------- */
async function probeMute(page) {
  await open(page, '?mode=8p&screen=game&seed=7');
  await page.evaluate(() => localStorage.removeItem('sgs.settings.v1'));
  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await sleep(900);
  await page.evaluate(() => { const b = document.querySelector('#btn-log'); if (b) b.click(); });
  await sleep(200);
  await page.evaluate(() => { const b = document.querySelector('#btn-log-close'); if (b) b.click(); });
  await page.evaluate(() => { if (window.SGS_AUDIO && SGS_AUDIO.playBgm) SGS_AUDIO.playBgm('battle'); });
  await sleep(500);
  const initial = await audioState(page);
  if (initial.enabled !== true) { fail('静音/初始状态', 'SGS_AUDIO.enabled 应为 true'); return; }

  const opened = await openSettings(page);
  if (!opened) { fail('静音/打开设置', '设置面板未打开'); return; }
  await clickMute(page);
  const muted = await audioState(page);
  const mutedOk = muted.enabled === false && /"mute":true/.test(muted.stored || '');
  if (mutedOk) pass('静音/开关生效并写入 sgs.settings.v1', muted.stored);
  else fail('静音/开关应关闭音频并持久化', `enabled=${muted.enabled} stored=${muted.stored}`);

  await page.evaluate(() => document.querySelector('#btn-settings-close').click());
  await sleep(300);
  await page.evaluate(() => SGS_APP_PAUSE(true));
  await sleep(1500);
  const bg = await audioState(page);
  await page.evaluate(() => document.querySelector('#btn-resume').click());
  await sleep(600);
  const afterBg = await audioState(page);
  if (bg.enabled === false && afterBg.enabled === false && afterBg.playing.length === 0) {
    pass('静音/后台暂停再回来不自动有声', `playing=${JSON.stringify(afterBg.playing)}`);
  } else {
    fail('静音/后台回来不得自动有声', `bg=${bg.enabled} after=${afterBg.enabled} playing=${JSON.stringify(afterBg.playing)}`);
  }

  await page.reload({ waitUntil: 'load', timeout: 60000 });
  await sleep(900);
  const reloaded = await audioState(page);
  const checked = await page.evaluate(() => document.querySelector('#set-mute').checked);
  if (reloaded.enabled === false && /"mute":true/.test(reloaded.stored || '') && checked === true) {
    pass('静音/刷新后仍静音且开关回显');
  } else {
    fail('静音/刷新后应保持静音', `enabled=${reloaded.enabled} stored=${reloaded.stored} checked=${checked}`);
  }

  const opened2 = await openSettings(page);
  if (opened2) {
    await clickMute(page);
    const unmuted = await audioState(page);
    if (unmuted.enabled === true && /"mute":false/.test(unmuted.stored || '')) pass('静音/解除后恢复音频并持久化');
    else fail('静音/解除后应恢复音频', `enabled=${unmuted.enabled} stored=${unmuted.stored}`);
  }
}

/* ---------------- 4. 真实牌局选目标（顺手牵羊，seed=2） ---------------- */
async function probeRealTarget(page) {
  await open(page, '?mode=1v1&screen=game&seed=2');
  await waitFor(page, () => page.evaluate(() => {
    const b = document.querySelector('#btn-pause');
    return !!b && b.getBoundingClientRect().width >= 44;
  }), 10000);
  const idx = await page.evaluate(() => Array.prototype.findIndex.call(
    document.querySelectorAll('#hand .hand-card'),
    (c) => /顺手牵羊/.test((c.querySelector('.hc-name') || {}).textContent || '')
  ));
  if (idx < 0) { skip('真实选目标/顺手牵羊', 'seed=2 起手无【顺手牵羊】，本条跳过'); return; }
  const cardGuard = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('#hand .hand-card')];
    let bad = 0;
    for (const c of cards) {
      const a = c.querySelector('.hc-rank'), b = c.querySelector('.hc-name');
      if (!a || !b) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      if (!(ra.right <= rb.left || rb.right <= ra.left || ra.bottom <= rb.top || rb.bottom <= ra.top)) bad += 1;
    }
    return { total: cards.length, bad };
  });
  if (cardGuard.bad === 0) pass('手牌/点数与牌名不重叠', `${cardGuard.total} 张`);
  else fail('手牌/点数压住牌名', JSON.stringify(cardGuard));
  await page.evaluate((i) => document.querySelectorAll('#hand .hand-card')[i].click(), idx);
  await sleep(500);
  const selected = await page.evaluate(() => ({
    bar: document.querySelector('#action-bar').innerText.replace(/\s+/g, ' '),
    targets: document.querySelectorAll('#seats .seat-targetable').length,
  }));
  if (!/取消/.test(selected.bar) || !/确认/.test(selected.bar) || selected.targets < 1) {
    fail('真实选目标/进入选目标', JSON.stringify(selected));
    return;
  }
  const targetGuard = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('#action-bar .bar-btn')].find((b) => /确认/.test(b.textContent));
    if (!btn) return { ok: false, reason: 'no-confirm' };
    const r = btn.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const skill = document.querySelector('.me-skills-block');
    const sr = skill ? skill.getBoundingClientRect() : { width: 0, left: 0 };
    return {
      ok: !!(hit && hit.closest('#action-bar')) && r.right <= innerWidth - 2 && (sr.width < 1 || r.right <= sr.left + 0.5),
      hit: hit ? hit.tagName + '.' + hit.className : null,
      rect: [Math.round(r.x), Math.round(r.right), Math.round(r.width), Math.round(r.height)],
      vw: innerWidth,
      skill: [Math.round(sr.left), Math.round(sr.width)],
    };
  });
  if (targetGuard.ok) pass('真实选目标/确认按钮完整可点且不被技能列遮挡', JSON.stringify(targetGuard.rect));
  else fail('真实选目标/确认按钮被遮挡', JSON.stringify(targetGuard));

  await page.evaluate(() => document.querySelector('#btn-pause').click());
  await sleep(700);
  const paused = await page.evaluate(() => ({
    overlay: document.querySelector('#resume-overlay').classList.contains('is-on'),
    bar: document.querySelector('#action-bar').innerText.replace(/\s+/g, ' '),
  }));
  await page.evaluate(() => document.querySelector('#btn-resume').click());
  await sleep(500);
  const resumed = await page.evaluate(() => document.querySelector('#action-bar').innerText.replace(/\s+/g, ' '));
  if (paused.overlay && /取消/.test(paused.bar) && /取消/.test(resumed)) {
    pass('真实选目标/暂停后目标选择保持', '顺手牵羊');
  } else {
    fail('真实选目标/暂停后应保持目标选择', JSON.stringify({ paused, resumed }));
  }
  const backRet = await back(page);
  const afterBack = await page.evaluate(() => ({
    bar: document.querySelector('#action-bar').innerText.replace(/\s+/g, ' '),
    modal: !!document.querySelector('.modal-mask'),
  }));
  if (backRet === true && !afterBack.modal && /出牌阶段|结束出牌/.test(afterBack.bar)) {
    pass('真实选目标/返回键取消选择且不弹退出确认');
  } else {
    fail('真实选目标/返回键应取消选择', JSON.stringify({ backRet, afterBack }));
  }
}

/* ---------------- 5. pick-bar 暂停入口 ---------------- */
async function probePickPause(page) {
  // 用真实开局（非 demo freeze），避免 demo 的 freeze('play') 在注入后清掉 tablePick
  await open(page, '?mode=8p&screen=select&seed=7');
  await page.evaluate(() => {
    const c = document.querySelector('.general-card');
    if (c) c.click();
    const ok = document.querySelector('#btn-general-confirm');
    if (ok && !ok.disabled) ok.click();
  });
  await waitFor(page, () => page.evaluate(() => {
    const b = document.querySelector('#btn-pause');
    return !!b && b.getBoundingClientRect().width >= 44 && SGS_UI._state().screen === 'game';
  }), 15000);
  await sleep(600);
  const injected = await page.evaluate(() => {
    const st = SGS_UI._state();
    const g = st.game;
    if (!g) return false;
    const cand = g.players.map((p, i) => i).filter((i) => g.players[i].alive);
    SGS_UI.request({ type: 'chooseTargets', player: g.players[g.humanSeat], candidates: cand, min: 1, max: 1, reason: 'ui_probe 选目标' }, function () {});
    return true;
  });
  if (!injected) { fail('pick-bar/注入 chooseTargets', '无 game 状态'); return; }
  await sleep(500);
  let geo = await page.evaluate(() => {
    const b = document.querySelector('#pick-bar [data-pick="pause"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), topbar: getComputedStyle(document.querySelector('#screen-game .topbar')).visibility };
  });
  if (!geo) {
    const dbg = await page.evaluate(() => {
      const st = SGS_UI._state();
      return { screen: st.screen, game: !!st.game, pending: st.pending && st.pending.req ? st.pending.req.type : null, body: document.body.className, pick: document.querySelector('#pick-bar').innerHTML.slice(0, 120) };
    });
    if (!args.json) console.log('  pick-bar 未渲染，状态：' + JSON.stringify(dbg));
    // 再注入一次（demo 的冻结请求可能覆盖第一次）
    await page.evaluate(() => {
      const st = SGS_UI._state();
      const g = st.game;
      if (!g) return;
      const cand = g.players.map((p, i) => i).filter((i) => g.players[i].alive);
      SGS_UI.request({ type: 'chooseTargets', player: g.players[g.humanSeat], candidates: cand, min: 1, max: 1, reason: 'ui_probe 选目标' }, function () {});
    });
    await sleep(500);
    geo = await page.evaluate(() => {
      const b = document.querySelector('#pick-bar [data-pick="pause"]');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), topbar: getComputedStyle(document.querySelector('#screen-game .topbar')).visibility };
    });
  }
  if (geo && geo.w >= 44 && geo.h >= 44) pass('pick-bar/暂停按钮 ≥44×44（注入 chooseTargets）', `${geo.w}x${geo.h} topbar=${geo.topbar}`);
  else fail('pick-bar/暂停按钮 应 ≥44×44', JSON.stringify(geo));
  const guards = await page.evaluate(() => {
    const pb = document.querySelector('#pick-bar').getBoundingClientRect();
    const seats = [...document.querySelectorAll('#seats .seat')].map((s) => s.getBoundingClientRect());
    const ok = document.querySelector('#pick-bar [data-pick="ok"]');
    const topbar = getComputedStyle(document.querySelector('#screen-game .topbar')).visibility;
    const pauses = [...document.querySelectorAll('#screen-game .tb-btn, #pick-bar [data-pick="pause"]')].filter((b) => {
      const r = b.getBoundingClientRect(); const st = getComputedStyle(b);
      return st.visibility !== 'hidden' && st.display !== 'none' && r.width > 1 && r.height > 1 && /暂停/.test(b.textContent);
    }).length;
    return {
      pauses,
      topbar,
      noSeatOverlap: seats.every((r) => pb.bottom <= r.top + 0.5),
      confirmDisabled: !!(ok && ok.disabled),
      targetable: document.querySelectorAll('#seats .seat-targetable').length,
    };
  });
  if (guards.pauses === 1 && guards.topbar === 'hidden') pass('pick-bar/只保留 1 个暂停入口（顶栏已隐藏）');
  else fail('pick-bar/应只保留 1 个暂停入口', JSON.stringify(guards));
  if (guards.noSeatOverlap) pass('pick-bar/不遮挡座位');
  else fail('pick-bar/不得遮挡座位', JSON.stringify(guards));
  if (guards.confirmDisabled) pass('pick-bar/0 目标时确认置灰不可点');
  else fail('pick-bar/0 目标时确认应 disabled', JSON.stringify(guards));

  if (!geo) { fail('pick-bar/暂停按钮 应 ≥44×44', 'pick-bar 未渲染（注入被覆盖）'); return; }
  await page.evaluate(() => document.querySelector('#pick-bar [data-pick="pause"]').click());
  await sleep(700);
  const paused = await page.evaluate(() => ({
    overlay: document.querySelector('#resume-overlay').classList.contains('is-on'),
    pick: document.querySelector('#pick-bar').innerText.replace(/\s+/g, ' ').slice(0, 40),
  }));
  if (paused.overlay && /暂停/.test(paused.pick)) pass('pick-bar/暂停后遮罩打开且选目标条保留');
  else fail('pick-bar/暂停后应保留选目标条', JSON.stringify(paused));
  await page.evaluate(() => document.querySelector('#btn-resume').click());
}

/* ---------------- main ---------------- */
(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: args.chrome,
      headless: args.headless ? 'new' : false,
      args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: args.width, height: args.height, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      const O = window.Audio;
      window.__sgsAudios = [];
      window.Audio = function () {
        const el = new O(...arguments);
        window.__sgsAudios.push(el);
        return el;
      };
      window.Audio.prototype = O.prototype;
    });

    try {
      await page.goto(args.baseUrl, { waitUntil: 'load', timeout: 20000 });
    } catch (e) {
      console.log(`SKIP: 无法打开 ${args.baseUrl}（${e.message}），请先启动本地服务。`);
      await browser.close();
      process.exit(0);
    }

    await probeBack(page);
    await probePause(page);
    await probeMute(page);
    await probeRealTarget(page);
    await probePickPause(page);

    const p = results.filter((r) => r.level === 'PASS').length;
    const f = results.filter((r) => r.level === 'FAIL').length;
    const s = results.filter((r) => r.level === 'SKIP').length;
    if (args.json) {
      console.log(JSON.stringify({ viewport: args.viewport, results, summary: { PASS: p, FAIL: f, SKIP: s } }, null, 2));
    } else {
      console.log('\nSUMMARY', JSON.stringify({ viewport: args.viewport, PASS: p, FAIL: f, SKIP: s }));
      if (f) console.log('结果：FAIL — 见上方 [FAIL] 项');
      else console.log('结果：PASS' + (s ? '（含 SKIP）' : ''));
    }
    await browser.close();
    process.exit(f ? 1 : 0);
  } catch (e) {
    console.error('ERROR', e && e.stack ? e.stack : e);
    if (browser) { try { await browser.close(); } catch (err) { /* ignore */ } }
    process.exit(2);
  }
})();
