/* 三国杀 · 单机版 — 启动与流程
 * 只负责创建 Game、注入 agent、菜单与演示模式；规则全部在引擎内。
 */
(function (global) {
  'use strict';

  const SGS = global.SGS;
  const D = global.SGS_DATA;
  const UI = global.SGS_UI;

  const BASE_PACKS = ['标准', '风', '火', '林', '山'];
  const EXTRA_PACK = 'extras';
  const ALL_PACKS = BASE_PACKS.concat([EXTRA_PACK]);
  const SAVE_KEY = 'sgs.save.v1';
  let lastSnapshot = null;
  const menu = { mode: '8p', cardPack: 'full', packs: BASE_PACKS.slice(), pace: 'normal', aiLevel: 'normal', duelPool: 'classic' };
  // 整体节奏档位：AI 决策间隔、阶段停顿、托管速度一起缩放
  const PACE_PROFILES = {
    slow: { ai: 2200, pause: 1.70, trust: 760, label: '慢' },
    normal: { ai: 1500, pause: 1.35, trust: 560, label: '标准' },
    fast: { ai: 850, pause: 0.80, trust: 380, label: '快' },
  };
  const PACE_MS = { slow: PACE_PROFILES.slow.ai, normal: PACE_PROFILES.normal.ai, fast: PACE_PROFILES.fast.ai };
  function paceCfg(p) { return PACE_PROFILES[p] || PACE_PROFILES.normal; }
  let session = 0;
  let lastStart = null;
  let trusteeship = false;
  let currentAI = null;
  let battleBgmOn = false;

  function q(id) { return document.getElementById(id); }

  /* ============================================================
     菜单
     ============================================================ */
  function initAudio() {
    try {
      const A = global.SGS_AUDIO;
      if (!A) return;
      // 先挂起菜单 BGM，首次交互解锁后由 audio.js 播放
      if (A.playBgm) A.playBgm('menu');
      if (A.preload) A.preload();
      // 捕获阶段：先解锁/起菜单 BGM，再让按钮自身的 startGame 切战斗 BGM
      document.addEventListener('click', function () {
        try {
          if (A.unlock) A.unlock();
          if (A.playBgm) A.playBgm('menu');
          if (A.play) A.play('click');
        } catch (e) { /* ignore */ }
      }, { once: true, capture: true });
    } catch (e) { /* ignore */ }
  }

  function saveSnapshot(snap) {
    lastSnapshot = snap;
    try {
      global.localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 1, time: Date.now(), mode: menu.mode, snapshot: snap }));
    } catch (e) { /* ignore */ }
    updateContinueButton();
  }

  function readSave() {
    try {
      const raw = global.localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && d.snapshot ? d : null;
    } catch (e) { return null; }
  }

  function clearSave() {
    lastSnapshot = null;
    try { global.localStorage.removeItem(SAVE_KEY); } catch (e) { /* ignore */ }
    updateContinueButton();
  }

  function updateContinueButton() {
    const btn = q('btn-continue');
    if (!btn) return;
    btn.classList.toggle('is-hidden', !readSave());
  }

  function loadGame() {
    const save = readSave();
    if (!save || !save.snapshot) { UI.toast('没有可继续的存档', true); return; }
    const snap = save.snapshot;
    session += 1;
    const mySession = session;
    const n = (snap.players || []).length || 2;
    menu.mode = save.mode || snap.mode || '8p';
    if (Array.isArray(snap.packs)) {
      menu.packs = snap.packs.filter(function (p) { return ALL_PACKS.indexOf(p) >= 0; });
    }
    updateMenuUI();
    trusteeship = false;
    try { UI.setTrust(false); } catch (e) { /* ignore */ }
    const game = new SGS.Game({
      mode: menu.mode,
      cardPack: snap.cardPack || menu.cardPack,
      packs: (snap.packs || menu.packs).slice(),
      paceFactor: paceCfg(menu.pace).pause,
      mulligan: false,
      seed: snap.seed,
      humanSeat: snap.humanSeat == null ? 0 : snap.humanSeat,
      agents: [],
      onUpdate: function (g) {
        if (mySession !== session) return;
        try { UI.render(g); } catch (err) { console.error(err); UI.showError(err); }
        if (g.started && !battleBgmOn) {
          battleBgmOn = true;
          try { if (global.SGS_AUDIO) global.SGS_AUDIO.playBgm('battle'); } catch (e) { /* ignore */ }
        }
        if (g.over) clearSave();
      },
      onSnapshot: function (s) { if (mySession === session) saveSnapshot(s); },
    });
    game.agents = buildAgents(game, n, {}, mySession, paceCfg(menu.pace).ai);
    try { if (global.SGS_AUDIO) global.SGS_AUDIO.playBgm('battle'); } catch (e) { /* ignore */ }
    UI.bindGame(game);
    try { game.restore(snap); } catch (e) { UI.toast('存档损坏，无法继续', true); return; }
    UI.render(game);
    game.resume().then(function () {
      if (mySession !== session) return;
      UI.render(game);
    }).catch(function (err) {
      if (mySession !== session) return;
      console.error('[SGS] 读档异常', err);
      UI.showError(err);
    });
  }

  function bindMenu() {
    const segMode = q('seg-mode');
    const segDeck = q('seg-deck');
    const segPacks = q('seg-packs');

    if (segMode) {
      segMode.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-mode]');
        if (!btn) return;
        menu.mode = btn.dataset.mode;
        updateMenuUI();
      });
    }
    if (segDeck) {
      segDeck.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-deck]');
        if (!btn) return;
        menu.cardPack = btn.dataset.deck;
        updateMenuUI();
      });
    }
    const segDuel = q('seg-duel-pool');
    if (segDuel) {
      segDuel.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-duel]');
        if (!btn) return;
        menu.duelPool = btn.dataset.duel;
        updateMenuUI();
      });
    }
    const segAI = q('seg-ai');
    if (segAI) {
      segAI.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-ai]');
        if (!btn) return;
        menu.aiLevel = btn.dataset.ai;
        updateMenuUI();
      });
    }
    const segPace = q('seg-pace');
    if (segPace) {
      segPace.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-pace]');
        if (!btn) return;
        menu.pace = btn.dataset.pace;
        updateMenuUI();
      });
    }
    if (segPacks) {
      segPacks.addEventListener('click', function (e) {
        const btn = e.target.closest('[data-pack]');
        if (!btn) return;
        const pack = btn.dataset.pack;
        const i = menu.packs.indexOf(pack);
        if (i >= 0) {
          if (menu.packs.length <= 1) {
            UI.toast('至少保留一个武将包', true);
            return;
          }
          menu.packs.splice(i, 1);
        } else {
          menu.packs.push(pack);
          menu.packs.sort(function (a, b) { return ALL_PACKS.indexOf(a) - ALL_PACKS.indexOf(b); });
        }
        updateMenuUI();
      });
    }

    const extrasToggle = q('toggle-extras');
    if (extrasToggle) {
      extrasToggle.addEventListener('change', function () {
        const at = menu.packs.indexOf(EXTRA_PACK);
        if (this.checked) {
          if (at < 0) menu.packs.push(EXTRA_PACK);
        } else if (at >= 0) {
          menu.packs.splice(at, 1);
        }
        menu.packs.sort(function (a, b) { return ALL_PACKS.indexOf(a) - ALL_PACKS.indexOf(b); });
        updateMenuUI();
      });
    }

    const btnSelectBack = q('btn-select-back');
    if (btnSelectBack) {
      btnSelectBack.addEventListener('click', function () {
        session += 1;
        try { UI.answerPending(null); } catch (e) { /* ignore */ }
        try { if (global.SGS_AUDIO) global.SGS_AUDIO.playBgm('menu'); } catch (e) { /* ignore */ }
        UI.showScreen('menu');
      });
    }
    q('btn-start').addEventListener('click', function () { startGame({ demo: false }); });
    q('btn-demo').addEventListener('click', function () { startGame({ demo: true, speed: 300 }); });
  }

  function updateMenuUI() {
    const segMode = q('seg-mode');
    if (segMode) {
      Array.prototype.forEach.call(segMode.querySelectorAll('[data-mode]'), function (b) {
        b.classList.toggle('is-on', b.dataset.mode === menu.mode);
      });
    }
    const segDeck = q('seg-deck');
    if (segDeck) {
      Array.prototype.forEach.call(segDeck.querySelectorAll('[data-deck]'), function (b) {
        b.classList.toggle('is-on', b.dataset.deck === menu.cardPack);
      });
    }
    const segPacks = q('seg-packs');
    if (segPacks) {
      Array.prototype.forEach.call(segPacks.querySelectorAll('[data-pack]'), function (b) {
        b.classList.toggle('is-on', menu.packs.indexOf(b.dataset.pack) >= 0);
      });
    }
    const extrasOn = menu.packs.indexOf(EXTRA_PACK) >= 0;
    const extrasToggle = q('toggle-extras');
    if (extrasToggle) extrasToggle.checked = extrasOn;
    const extrasTitle = q('extras-title');
    if (extrasTitle) extrasTitle.textContent = extrasOn ? '变体扩展（已开启）' : '变体扩展（默认关闭）';
    const extrasStatus = q('extras-status');
    if (extrasStatus) {
      const extrasCount = D.GENERALS.filter(function (g) { return g.pack === EXTRA_PACK; }).length;
      extrasStatus.textContent = extrasOn
        ? (extrasCount ? ('已加入将池 · 当前 ' + extrasCount + ' 名变体武将') : '已加入将池 · 等待变体武将数据')
        : '开启后加入 30 名变体武将';
    }
    const segPace = q('seg-pace');
    if (segPace) {
      Array.prototype.forEach.call(segPace.querySelectorAll('[data-pace]'), function (b) {
        b.classList.toggle('is-on', b.dataset.pace === menu.pace);
      });
    }
    const segAI = q('seg-ai');
    if (segAI) {
      Array.prototype.forEach.call(segAI.querySelectorAll('[data-ai]'), function (b) {
        b.classList.toggle('is-on', b.dataset.ai === menu.aiLevel);
      });
    }
    const rowDuel = q('row-duel-pool');
    if (rowDuel) rowDuel.classList.toggle('is-hidden', menu.mode !== '1v1');
    const segDuel = q('seg-duel-pool');
    if (segDuel) {
      Array.prototype.forEach.call(segDuel.querySelectorAll('[data-duel]'), function (b) {
        b.classList.toggle('is-on', b.dataset.duel === menu.duelPool);
      });
    }
    const n = menu.mode === '8p' ? 8 : (menu.mode === '5p' ? 5 : (menu.mode === '1v1' ? 2 : (menu.mode === '2v2' ? 4 : (menu.mode === '3v3' ? 6 : 3))));
    const total = D.GENERALS.filter(function (g) { return menu.packs.indexOf(g.pack) >= 0; }).length;
    const ddz = menu.mode === 'ddz';
    const team = menu.mode === '2v2' || menu.mode === '3v3';
    const per = ddz ? 3 : (menu.mode === '1v1'
      ? Math.min(4, Math.max(1, Math.floor(total / n)))
      : (team ? 3 : Math.min(5, Math.max(1, Math.floor(total / n)))));
    const logoSub = q('logo-sub');
    if (logoSub) logoSub.textContent = '身份局 · 标准与军争牌堆 · ' + total + ' 名武将';
    const note = q('menu-note');
    if (note) {
      const modeText = ddz ? '斗地主 1v2 · 每人 ' : (menu.mode === '1v1' ? '单挑 · 每人 ' : (n + ' 人' + (team ? (menu.mode === '2v2' ? ' 2v2' : ' 3v3') : '局') + '每人 '));
      const deckText = (menu.mode === '1v1' || ddz) ? (ddz ? '标准+军争 160 张（固定）' : '军争剪裁 108 张（固定）') : (menu.cardPack === 'full' ? '标准+军争 160 张' : '标准 108 张');
      note.textContent = '已选 ' + menu.packs.length + ' 个武将包 · ' + total + ' 名武将 · ' +
        modeText + per + ' 张候选 · 牌堆 ' + deckText + ' · 节奏 ' + ({ slow: '慢', normal: '标准', fast: '快' }[menu.pace] || '标准') + ' · AI ' + ({ easy: '简单', normal: '普通', hard: '困难' }[menu.aiLevel] || '普通') + (menu.mode === '1v1' ? ' · 将池 ' + (menu.duelPool === 'classic' ? '经典' : (menu.duelPool === 'new1v1' ? '新1V1（46/50，基础技能近似）' : '全武将')) : '') + (extrasOn ? ' · 扩展已开启' : '');
    }
    const deckRow = q('row-deck');
    const deckBtns = document.querySelectorAll('#seg-deck [data-deck]');
    const duel = menu.mode === '1v1';
    const deckLocked = duel || ddz;
    if (deckRow) {
      deckRow.classList.toggle('is-off', deckLocked);
      deckRow.setAttribute('data-lock', menu.mode === 'ddz' ? '（斗地主固定）' : (duel ? '（单挑固定）' : ''));
    }
    Array.prototype.forEach.call(deckBtns, function (b) { b.disabled = deckLocked; });
    const start = q('btn-start');
    const demo = q('btn-demo');
    const enough = ddz ? total >= n * 3 : total >= n;
    if (start) start.disabled = !enough;
    if (demo) demo.disabled = !enough;
    if (!enough && note) note.textContent = ddz ? '斗地主至少需要 ' + (n * 3) + ' 名武将，请多选武将包' : ('当前武将包不足以支撑 ' + n + ' 人局，请多选武将包');
  }

  /* ============================================================
     对局启动
     ============================================================ */
  function buildAgents(game, n, opts, mySession, speed) {
    const agents = [];
    const humanAI = new SGS.AI(game, 0, { speed: Math.max(320, Math.round((speed || 1000) * 0.35)), aiLevel: menu.aiLevel });
    currentAI = humanAI;
    for (let seat = 0; seat < n; seat++) {
      if (seat === 0 && !opts.demo) agents.push(humanAgent(mySession, humanAI));
      else if (seat === 0 && opts.demo) agents.push(demoAgent(game, mySession, opts, speed));
      else agents.push(new SGS.AI(game, seat, { speed: speed, aiLevel: menu.aiLevel }));
    }
    return agents;
  }

  function startGame(opts) {
    opts = opts || {};
    session += 1;
    const mySession = session;
    const n = menu.mode === '8p' ? 8 : (menu.mode === '5p' ? 5 : (menu.mode === '1v1' ? 2 : (menu.mode === '2v2' ? 4 : (menu.mode === '3v3' ? 6 : 3))));
    const seed = (opts.seed != null && !isNaN(opts.seed)) ? Number(opts.seed) : (Date.now() & 0x7fffffff);
    lastStart = {
      demo: !!opts.demo,
      fast: !!opts.fast,
      freeze: opts.freeze || null,
      speed: opts.speed,
      seed: null,
      preview: opts.preview || null,
    };

    trusteeship = false;
    battleBgmOn = false;
    try { UI.setTrust(false); } catch (e) { /* ignore */ }
    if (!opts.keepSave) clearSave();
    const game = new SGS.Game({
      mode: menu.mode,
      cardPack: menu.mode === 'ddz' ? 'full' : menu.cardPack,
      packs: menu.packs.slice(),
      paceFactor: opts.demo ? 0.45 : paceCfg(menu.pace).pause,
      mulligan: !opts.demo,
      duelPool: menu.duelPool,
      seed: seed,
      humanSeat: 0,
      agents: [],
      onUpdate: function (g) {
        if (mySession !== session) return;
        try { UI.render(g); } catch (err) { console.error(err); UI.showError(err); }
        if (g.started && !battleBgmOn) {
          battleBgmOn = true;
          try { if (global.SGS_AUDIO) global.SGS_AUDIO.playBgm('battle'); } catch (e) { /* ignore */ }
        }
        if (g.over) clearSave();
      },
      onSnapshot: function (snap) {
        if (mySession !== session) return;
        saveSnapshot(snap);
      },
    });

    const speed = (opts.speed != null && !isNaN(opts.speed)) ? Number(opts.speed) : (opts.demo ? 300 : paceCfg(menu.pace).ai);
    if (opts.fast) {
      // 截图/调试专用：跳过引擎演出停顿，让真实对局快速跑到终局
      game.pause = function () { return Promise.resolve(); };
    }
    game.agents = buildAgents(game, n, opts, mySession, speed);
    if (global.SGS_AUDIO && global.SGS_AUDIO.preloadGenerals) {
      setTimeout(function () {
        try {
          const ids = (game.players || []).map(function (p) { return p.general && p.general.id; }).filter(Boolean);
          global.SGS_AUDIO.preloadGenerals(ids);
        } catch (e) { /* ignore */ }
      }, 800);
    }

    UI.bindGame(game);
    UI.render(game);

    game.start().then(function () {
      if (mySession !== session) return;
      UI.render(game);
    }).catch(function (err) {
      if (mySession !== session) return;
      console.error('[SGS] 对局异常', err);
      UI.showError(err);
    });
  }

  function humanAgent(mySession, ai) {
    return {
      decide: function (req) {
        if (mySession !== session) return Promise.resolve(null);
        if (trusteeship && ai) return ai.decide(req);
        return new Promise(function (resolve) {
          UI.request(req, resolve);
        });
      },
    };
  }

  function demoAgent(game, mySession, opts, speed) {
    const ai = new SGS.AI(game, 0, { speed: speed, aiLevel: menu.aiLevel });
    let frozen = false;
    return {
      decide: function (req) {
        if (mySession !== session) return Promise.resolve(null);
        if (!frozen && opts.freeze && req.type === opts.freeze && req.player && req.player.seat === 0) {
          frozen = true;
          UI.freeze(req);
          if (opts.preview) UI.preview(opts.preview);
          return new Promise(function () { /* 冻结画面用于截图 */ });
        }
        return ai.decide(req);
      },
    };
  }

  /* ============================================================
     查询参数（截图 / 调试）
     ============================================================ */
  function readParams() {
    const params = new URLSearchParams(global.location.search);
    if (params.has('mode')) {
      const mode = params.get('mode');
      menu.mode = ['5p', '1v1', '2v2', '3v3', 'ddz'].indexOf(mode) >= 0 ? mode : '8p';
    }
    if (params.has('deck')) {
      menu.cardPack = params.get('deck') === 'standard' ? 'standard' : 'full';
    }
    if (params.has('pace')) {
      const pace = params.get('pace');
      if (PACE_MS[pace]) menu.pace = pace;
    }
    if (params.has('packs')) {
      const list = params.get('packs').split(',').map(function (s) { return s.trim(); })
        .filter(function (s) { return ALL_PACKS.indexOf(s) >= 0; });
      if (list.length) menu.packs = list;
    }
    updateMenuUI();

    const seed = params.has('seed') ? Number(params.get('seed')) : undefined;
    const speed = params.has('speed') ? Number(params.get('speed')) : undefined;
    const preview = params.get('preview') || null;

    if (params.has('demo')) {
      const freeze = params.get('freeze') || null;
      startGame({
        demo: true,
        freeze: freeze,
        preview: preview,
        seed: seed,
        speed: speed == null ? 300 : speed,
        fast: params.has('fast'),
      });
      return true;
    }
    if (params.get('screen') === 'select') {
      startGame({ demo: false, seed: seed, speed: speed });
      return true;
    }
    if (params.get('screen') === 'game') {
      startGame({ demo: true, freeze: 'play', preview: preview, seed: seed, speed: speed == null ? 0 : speed });
      return true;
    }
    if (params.get('screen') === 'result') {
      startGame({ demo: true, seed: seed, speed: speed == null ? 0 : speed, fast: true });
      return true;
    }
    return false;
  }

  /* ============================================================
     入口
     ============================================================ */
  function boot() {
    const bootParams = new URLSearchParams(global.location.search);
    if (bootParams.has('nofx')) document.body.classList.add('no-anim');
    UI.init({
      onQuit: function () {
        if (UI._state && UI._state().game && !UI._state().game.over) {
          UI.confirmDialog('退出本局将判负，确定返回主菜单？', function () {
            UI.surrender();
            session += 1;
            UI.showScreen('menu');
            try { if (global.SGS_AUDIO) global.SGS_AUDIO.playBgm('menu'); } catch (e) { /* ignore */ }
          }, { okText: '退出' });
          return;
        }
        session += 1;
        try { if (global.SGS_AUDIO) global.SGS_AUDIO.playBgm('menu'); } catch (e) { /* ignore */ }
        UI.showScreen('menu');
      },
      onSave: function () {
        if (!lastSnapshot) { UI.toast('本回合刚开始，暂无可保存进度', true); return; }
        saveSnapshot(lastSnapshot);
        UI.toast('已保存（读档从本回合开始）');
      },
      onContinue: function () { loadGame(); },
      onSurrender: function () {
        UI.confirmDialog('确定投降？本局将判负。', function () { UI.surrender(); }, { okText: '投降' });
      },
      onTrust: function () {
        trusteeship = !trusteeship;
        UI.setTrust(trusteeship);
        UI.toast(trusteeship ? '已开启托管，AI 将代你行动' : '已取消托管');
        if (trusteeship) {
          const st = UI._state && UI._state();
          const req = st && st.pending && st.pending.req;
          if (req) {
            /* 让当前等待中的请求由 AI 立即处理 */
            const ans = currentAI ? currentAI.decide(req) : null;
            Promise.resolve(ans).then(function (a) { try { UI.answerPending(a); } catch (e) { /* ignore */ } });
          }
        }
      },
      getPace: function () { return menu.pace; },
      onPaceChange: function (pace) {
        if (!PACE_MS[pace]) return;
        menu.pace = pace;
        updateMenuUI();
        // 当前对局已在行动的 AI：即时更新间隔
        try {
          const st = UI._state && UI._state();
          const g = st && st.game;
          if (g && g.agents) {
            const cfg = paceCfg(pace);
            if (typeof g.paceFactor === 'number') g.paceFactor = cfg.pause;
            g.agents.forEach(function (a) {
              if (a && typeof a.speed === 'number') a.speed = cfg.ai;
            });
            if (currentAI && typeof currentAI.speed === 'number') currentAI.speed = cfg.trust;
          }
        } catch (e) { /* ignore */ }
      },
      onAgain: function () {
        const prev = lastStart || { demo: false };
        if (prev.demo) {
          startGame({ demo: true, speed: 300, seed: undefined });
        } else {
          startGame({ demo: false, seed: undefined });
        }
      },
      onHome: function () {
        session += 1;
        try { if (global.SGS_AUDIO) global.SGS_AUDIO.playBgm('menu'); } catch (e) { /* ignore */ }
        UI.showScreen('menu');
      },
    });

    bindMenu();
    updateMenuUI();
    updateContinueButton();

    const params = new URLSearchParams(global.location.search);
    if (params.get('screen') === 'home' || params.get('screen') === 'menu') {
      UI.showScreen('menu');
      return;
    }
    readParams();
  }

  function registerSW() {
    try {
      if (!('serviceWorker' in global.navigator)) return;
      if (!/^https?:$/.test(global.location.protocol)) return;
      global.navigator.serviceWorker.register('sw.js').catch(function () { /* file:// 或不支持 */ });
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { initAudio(); boot(); registerSW(); });
  } else {
    boot(); registerSW();
  }
})(typeof window !== 'undefined' ? window : globalThis);
