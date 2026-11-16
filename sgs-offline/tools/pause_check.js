#!/usr/bin/env node
/* 暂停冻结回归（不变量 3/4）
 * 用 puppeteer-core 驱动真实页面（默认 http://127.0.0.1:8899/）：
 *   - 出牌阶段：1v1 选将后人类 0 号位的出牌询问
 *   - 求桃询问：在真实 Game 上调用 askForPeach 生成 response 请求（UI 真实渲染）
 * 分别在两个时机执行：
 *   a) 后台暂停 SGS_APP_PAUSE(true)
 *   b) 手动暂停 SGS_APP_PAUSE(true,{keepAudio:true})
 * 断言：倒计时剩余值不变、引擎无推进（日志/回合/阶段/请求不变）、
 *       手动暂停时音频未被 suspend、恢复后从剩余时间继续且不重置/不跳秒。
 *
 * 用法：
 *   node tools/pause_check.js           # 人读输出
 *   node tools/pause_check.js --json    # 最后一行输出 JSON，供 audit_rules 调用
 * 环境变量：
 *   SGS_BASE_URL  默认 http://127.0.0.1:8899/
 *   SGS_CHROME    默认 macOS Chrome 路径
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const puppeteer = require('puppeteer-core');

const BASE = process.env.SGS_BASE_URL || 'http://127.0.0.1:8899/';
const CHROME = process.env.SGS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WAIT_FREEZE_MS = 5200;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
  console.log((cond ? 'PASS ' : 'FAIL ') + name + ' :: ' + (detail || ''));
}

async function countdown(page) {
  return page.evaluate(() => {
    const ids = ['tb-count', 'hand-timer', 'orbit-timer'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const m = String(el.textContent || '').match(/(\d+)\s*s/);
      if (m) return Number(m[1]);
    }
    return null;
  });
}

async function snapshot(page) {
  return page.evaluate(() => {
    const st = window.SGS_UI && window.SGS_UI._state ? window.SGS_UI._state() : null;
    const g = st && st.game;
    const el = document.getElementById('tb-count');
    const req = st && st.pending && st.pending.req ? st.pending.req : null;
    return {
      logs: g ? g.logs.length : -1,
      turn: g ? g.turnCount : -1,
      phase: g ? g.phase : null,
      seat: g ? g.currentSeat : -1,
      paused: g ? !!g.paused : null,
      reqType: req ? req.type : null,
      reqReason: req ? (req.reason || '') : '',
      reqSeat: req && req.player ? req.player.seat : null,
      countText: el ? String(el.textContent || '') : '',
      count: (() => { const m = (el ? el.textContent : '').match(/(\d+)\s*s/); return m ? Number(m[1]) : null; })(),
    };
  });
}

function sameEngine(a, b) {
  return a.logs === b.logs && a.turn === b.turn && a.phase === b.phase && a.seat === b.seat && a.reqType === b.reqType && a.reqReason === b.reqReason && a.reqSeat === b.reqSeat;
}

async function installAudioSpy(page) {
  await page.evaluate(() => {
    window.__pauseSpy = { suspend: 0, resume: 0 };
    const A = window.SGS_AUDIO;
    if (!A) return;
    if (!A.__pauseSpyInstalled) {
      const os = A.suspend ? A.suspend.bind(A) : null;
      const or = A.resume ? A.resume.bind(A) : null;
      if (os) A.suspend = function () { window.__pauseSpy.suspend++; return os.apply(A, arguments); };
      if (or) A.resume = function () { window.__pauseSpy.resume++; return or.apply(A, arguments); };
      A.__pauseSpyInstalled = true;
    }
  });
}

async function resetSpy(page) {
  await page.evaluate(() => { window.__pauseSpy = { suspend: 0, resume: 0 }; });
}

async function readSpy(page) {
  return page.evaluate(() => (window.__pauseSpy || { suspend: 0, resume: 0 }));
}

async function pause(page, opts) {
  await page.evaluate((o) => window.SGS_APP_PAUSE(true, o || undefined), opts || null);
}

async function resume(page) {
  await page.evaluate(() => window.SGS_APP_PAUSE(false));
}

// 一个时机（play / response）跑后台 + 手动两轮
async function runTiming(page, label, expectSecs) {
  // 先等读秒走低，确保「恢复不重置」可判别
  await page.waitForFunction((secs) => {
    const ids = ['tb-count', 'hand-timer', 'orbit-timer'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      const m = String(el.textContent || '').match(/(\d+)\s*s/);
      if (m) return Number(m[1]) <= secs;
    }
    return false;
  }, { timeout: 15000 }, expectSecs - 2);
  const s0 = await snapshot(page);
  check(label + ' 存在倒计时', s0.count != null, s0.countText || '(无)');

  // ---------- a) 后台暂停 ----------
  await resetSpy(page);
  await pause(page);
  await sleep(700);
  const p1 = await snapshot(page);
  await sleep(WAIT_FREEZE_MS);
  const p2 = await snapshot(page);
  const spy = await readSpy(page);
  check(label + ' 后台暂停倒计时冻结', p2.count != null && p2.count === p1.count && p2.countText === p1.countText,
    '暂停前=' + p1.countText + '，5s后=' + p2.countText);
  check(label + ' 后台暂停引擎无推进', sameEngine(p1, p2),
    'logs ' + p1.logs + '->' + p2.logs + '，turn ' + p1.turn + '->' + p2.turn + '，phase ' + p1.phase + '->' + p2.phase + '，req ' + p1.reqType + '->' + p2.reqType);
  check(label + ' 后台暂停 game.paused=true', p2.paused === true, 'paused=' + p2.paused);
  check(label + ' 后台暂停音频挂起', spy.suspend >= 1, 'SGS_AUDIO.suspend 次数=' + spy.suspend);

  await resume(page);
  const r0 = await snapshot(page);
  check(label + ' 后台恢复不重置/不跳秒', r0.count != null && r0.count <= p1.count && r0.count >= p1.count - 2 && r0.count < expectSecs,
    '暂停值=' + p1.count + '，恢复值=' + r0.count + '，满值=' + expectSecs);
  check(label + ' 后台恢复后引擎仍等待原请求', sameEngine(p1, r0), 'req=' + r0.reqType);
  await sleep(1300);
  const r1 = await snapshot(page);
  check(label + ' 后台恢复后倒计时继续', r1.count != null && r1.count <= r0.count && r1.count >= r0.count - 2,
    '恢复=' + r0.count + '，1.3s后=' + r1.count);

  // ---------- b) 手动暂停（keepAudio） ----------
  await resetSpy(page);
  await pause(page, { keepAudio: true });
  await sleep(700);
  const m1 = await snapshot(page);
  await sleep(WAIT_FREEZE_MS);
  const m2 = await snapshot(page);
  const spy2 = await readSpy(page);
  check(label + ' 手动暂停倒计时冻结', m2.count != null && m2.count === m1.count && m2.countText === m1.countText,
    '暂停时=' + m1.countText + '，5s后=' + m2.countText);
  check(label + ' 手动暂停引擎无推进', sameEngine(m1, m2),
    'logs ' + m1.logs + '->' + m2.logs + '，turn ' + m1.turn + '->' + m2.turn + '，req ' + m1.reqType + '->' + m2.reqType);
  check(label + ' 手动暂停 game.paused=true', m2.paused === true, 'paused=' + m2.paused);
  check(label + ' 手动暂停保留音乐（未 suspend/resume）', spy2.suspend === 0 && spy2.resume === 0,
    'suspend=' + spy2.suspend + '，resume=' + spy2.resume);

  await resume(page);
  const mr0 = await snapshot(page);
  check(label + ' 手动恢复不重置/不跳秒', mr0.count != null && mr0.count <= m1.count && mr0.count >= m1.count - 2 && mr0.count < expectSecs,
    '暂停值=' + m1.count + '，恢复值=' + mr0.count + '，满值=' + expectSecs);
  await sleep(1300);
  const mr1 = await snapshot(page);
  check(label + ' 手动恢复后倒计时继续', mr1.count != null && mr1.count <= mr0.count && mr1.count >= mr0.count - 2,
    '恢复=' + mr0.count + '，1.3s后=' + mr1.count);
}

async function openHumanGame(page) {
  await page.goto(BASE + '?mode=1v1&screen=select&seed=12345&pace=fast&speed=0', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('.general-card', { timeout: 20000 });
  await page.click('.general-card[data-index="0"]');
  await page.waitForFunction(() => { const b = document.getElementById('btn-general-confirm'); return b && !b.disabled; }, { timeout: 5000 });
  await page.click('#btn-general-confirm');
  await page.waitForFunction(() => {
    const st = window.SGS_UI && window.SGS_UI._state ? window.SGS_UI._state() : null;
    return !!(st && st.pending && st.pending.req && st.pending.req.type === 'play');
  }, { timeout: 30000 });
  await page.waitForFunction(() => { const el = document.getElementById('tb-count'); return el && /(\d+)\s*s/.test(el.textContent || ''); }, { timeout: 10000 });
}

async function injectPeachRequest(page) {
  await page.evaluate(() => {
    const st = window.SGS_UI._state();
    const g = st.game;
    const healer = g.players[0];
    const dying = g.players[1];
    if (!healer || !dying) throw new Error('players missing');
    healer.hand.push(g.makeCard('tao', 'heart', 12, 99001));
    dying.alive = true;
    dying.hp = 0;
    g.ask = function (p, req) {
      return new Promise(function (resolve) { window.SGS_UI.request(req, resolve); });
    };
    g.askForPeach(healer, dying);
  });
  await page.waitForFunction(() => {
    const st = window.SGS_UI && window.SGS_UI._state ? window.SGS_UI._state() : null;
    const req = st && st.pending && st.pending.req;
    return !!(req && req.type === 'response' && /桃/.test(req.reason || ''));
  }, { timeout: 10000 });
  await page.waitForFunction(() => { const el = document.getElementById('tb-count'); return el && /(\d+)\s*s/.test(el.textContent || ''); }, { timeout: 10000 });
}

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.error('Chrome 不存在: ' + CHROME + '（可用 SGS_CHROME 指定）');
    process.exit(2);
  }
  try {
    const resp = await fetch(BASE);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
  } catch (e) {
    console.error('本地服务不可用: ' + BASE + '（先运行 python3 tools/serve.py 8899）');
    process.exit(2);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sgs-pause-'));
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      userDataDir: profile,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error('[pageerror]', e && e.message));
    await installAudioSpy(page);

    await openHumanGame(page);
    await installAudioSpy(page);
    await runTiming(page, '出牌阶段', 90);

    await injectPeachRequest(page);
    await runTiming(page, '求桃询问', 45);
  } catch (e) {
    console.error('HARNESS ERROR', e && e.stack || e);
    results.push({ name: 'pause_check 执行', pass: false, detail: String(e && e.message || e) });
  } finally {
    try { if (browser) await browser.close(); } catch (e) { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  const pass = results.filter((r) => r.pass).length;
  const ok = pass === results.length && results.length > 0;
  console.log('\nSUMMARY pause_check pass=' + pass + '/' + results.length);
  if (process.argv.indexOf('--json') >= 0) {
    console.log(JSON.stringify({ pass, total: results.length, ok, results }));
  }
  process.exit(ok ? 0 : 1);
})();
