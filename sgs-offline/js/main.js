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
  const SETTINGS_KEY = 'sgs.settings.v1';

  function q(id) { return document.getElementById(id); }

  function readSettings() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(SETTINGS_KEY);
      return raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) { return {}; }
  }

  function writeSettings(patch) {
    try {
      const st = readSettings();
      Object.keys(patch || {}).forEach(function (k) { st[k] = patch[k]; });
      global.localStorage.setItem(SETTINGS_KEY, JSON.stringify(st));
    } catch (e) { /* ignore */ }
  }

  // 静音与“后台/手动暂停”分离：静音只关闭音频总开关，不改变暂停态；
  // 暂停中的解除静音重新 suspend，避免在暂停遮罩下提前出声。
  function applyMute(muted, persist) {
    muted = !!muted;
    const A = global.SGS_AUDIO;
    if (A) {
      const want = !muted;
      if (A.enabled !== want) A.enabled = want;
      if (!muted && global.__SGS_LAST_PAUSE && typeof A.suspend === 'function') {
        try { A.suspend(); } catch (e) { /* ignore */ }
      }
    }
    const cb = q('set-mute');
    if (cb) cb.checked = muted;
    if (persist) writeSettings({ mute: muted });
  }

  function syncMuteSwitch() {
    const cb = q('set-mute');
    if (cb) cb.checked = !!readSettings().mute;
  }

  function initAudio() {
    try {
      applyMute(!!readSettings().mute, false);
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

  // 存档：1 个自动档（每回合滚动）+ 3 个手动槽位；旧 sgs.save.v1 首次启动迁移为自动档
  const LEGACY_SAVE_KEY = 'sgs.save.v1';
  const SAVE_AUTO_KEY = 'sgs.save.auto';
  const SAVE_SLOT_KEYS = ['sgs.save.slot1', 'sgs.save.slot2', 'sgs.save.slot3'];
  const SAVE_VERSION = 2;
  const MODE_LABELS = { '8p': '八人身份局', '5p': '五人身份局', '1v1': '单挑', '2v2': '2v2', '3v3': '3v3', ddz: '斗地主' };
  let lastSnapshot = null;          // 最近一次“回合开始”快照（手动保存也用它）
  let autoInfo = { status: 'empty' };
  let slotInfo = [{ status: 'empty' }, { status: 'empty' }, { status: 'empty' }];
  let saveNotices = [];
  let autosaveFailed = false;
  let autosaveToastTimer = 0;
  let savesPanelMode = null;        // 'save' | 'load'
  let savesPanelEl = null;
  let pendingSlotAction = null;     // { type:'overwrite'|'delete', slot, until }
  let pendingSlotTimer = 0;

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function formatSaveTime(ms) {
    if (!ms) return '—';
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return '—';
    return (d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function modeLabel(mode) { return MODE_LABELS[mode] || mode || '对局'; }
  function byteLength(str) {
    try { return new TextEncoder().encode(String(str)).length; }
    catch (e) { return String(str).length * 2; }
  }

  function buildSaveMeta(snap, time) {
    const hs = snap && snap.humanSeat != null ? snap.humanSeat : 0;
    const me = snap && snap.players ? snap.players[hs] : null;
    return {
      mode: snap && snap.mode,
      turn: Math.max(1, Number(snap && snap.turnCount) || 0),
      general: me && me.general ? me.general.name : '—',
      time: time || Date.now(),
      // 身份标记是玩家私有笔记：只进信封 meta，不写 players
      marks: (UI && typeof UI.getSeatMarks === 'function') ? UI.getSeatMarks() : {},
    };
  }

  function makeSaveEnvelope(kind, snap, time) {
    const t = time || Date.now();
    return {
      v: SAVE_VERSION, kind: kind, time: t,
      mode: snap.mode, meta: buildSaveMeta(snap, t), snapshot: snap,
    };
  }

  function safeGetItem(key) {
    try { return global.localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSetItem(key, raw) {
    try { global.localStorage.setItem(key, raw); return true; } catch (e) { return false; }
  }
  function safeRemoveItem(key) {
    try { global.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  // 返回 { status:'empty'|'ok'|'corrupt', save?, bytes? }
  function readSaveAt(key) {
    const raw = safeGetItem(key);
    if (!raw) return { status: 'empty' };
    let d = null;
    try { d = JSON.parse(raw); } catch (e) { return { status: 'corrupt', bytes: byteLength(raw) }; }
    if (!d || !d.snapshot || !Array.isArray(d.snapshot.players) || !d.snapshot.players.length || !d.snapshot.mode) {
      return { status: 'corrupt', bytes: byteLength(raw) };
    }
    const snap = d.snapshot;
    return {
      status: 'ok', bytes: byteLength(raw),
      save: {
        v: d.v || 1, kind: d.kind || 'auto', time: Number(d.time) || 0,
        mode: d.mode || snap.mode,
        meta: (d.meta && typeof d.meta === 'object') ? d.meta : buildSaveMeta(snap, Number(d.time) || Date.now()),
        snapshot: snap,
      },
    };
  }

  function writeSaveAt(key, env) {
    let raw = '';
    try { raw = JSON.stringify(env); } catch (e) { return { ok: false, bytes: 0 }; }
    if (!safeSetItem(key, raw)) return { ok: false, bytes: byteLength(raw) };
    return { ok: true, bytes: byteLength(raw) };
  }

  function pushSaveNotice(text) {
    if (text && saveNotices.indexOf(text) < 0) saveNotices.push(text);
  }

  function refreshAutoInfo() {
    const r = readSaveAt(SAVE_AUTO_KEY);
    if (r.status === 'corrupt') { safeRemoveItem(SAVE_AUTO_KEY); autoInfo = { status: 'empty' }; pushSaveNotice('存档损坏，已清除'); }
    else autoInfo = r;
    return autoInfo;
  }

  function refreshSlotInfo(index) {
    const r = readSaveAt(SAVE_SLOT_KEYS[index]);
    if (r.status === 'corrupt') { safeRemoveItem(SAVE_SLOT_KEYS[index]); slotInfo[index] = { status: 'empty' }; pushSaveNotice('存档损坏，已清除'); }
    else slotInfo[index] = r;
    return slotInfo[index];
  }

  function refreshAllSaves() {
    refreshAutoInfo();
    for (let i = 0; i < SAVE_SLOT_KEYS.length; i++) refreshSlotInfo(i);
    updateSaveButtons();
  }

  function updateSaveButtons() {
    const btn = q('btn-continue');
    const meta = q('continue-meta');
    const savesBtn = q('btn-saves');
    const okAuto = autoInfo.status === 'ok' && autoInfo.save;
    const wrap = q('continue-wrap');
    if (wrap) wrap.classList.toggle('is-hidden', !okAuto);
    if (btn) btn.classList.toggle('is-hidden', !okAuto);
    if (meta) {
      meta.classList.toggle('is-hidden', !okAuto);
      if (okAuto) {
        const m = autoInfo.save.meta || {};
        meta.textContent = modeLabel(autoInfo.save.mode) + ' · 第 ' + (m.turn || 1) + ' 回合 · ' + formatSaveTime(autoInfo.save.time);
      } else {
        meta.textContent = '';
      }
    }
    const anySlot = slotInfo.some(function (x) { return x.status === 'ok'; });
    if (savesBtn) savesBtn.classList.toggle('is-hidden', !(okAuto || anySlot));
  }

  function showAutoSaveToast(text, isError) {
    let el = q('autosave-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'autosave-toast';
      el.className = 'autosave-toast';
      (document.getElementById('app') || document.body).appendChild(el);
    }
    el.textContent = text;
    el.classList.toggle('is-error', !!isError);
    el.classList.add('is-on');
    if (autosaveToastTimer) clearTimeout(autosaveToastTimer);
    autosaveToastTimer = setTimeout(function () {
      autosaveToastTimer = 0;
      el.classList.remove('is-on');
    }, isError ? 2600 : 1500);
  }

  function saveAuto(snap, opts) {
    if (!snap) return false;
    const env = makeSaveEnvelope('auto', snap);
    const w = writeSaveAt(SAVE_AUTO_KEY, env);
    if (w.ok) {
      autoInfo = { status: 'ok', save: env, bytes: w.bytes };
      autosaveFailed = false;
      if (!opts || !opts.silent) showAutoSaveToast('已自动保存');
    } else {
      // 写失败时保留上一次仍可用的自动档信息，不能把已有存档判成不可继续
      if (autosaveFailed) { /* 已在本次失败中提示过 */ }
      if (!autosaveFailed) {
        autosaveFailed = true;
        showAutoSaveToast('自动保存失败：存储空间不足', true);
        UI.toast('自动保存失败：存储空间不足或浏览器限制', true);
      }
    }
    updateSaveButtons();
    return w.ok;
  }

  function clearAuto() {
    safeRemoveItem(SAVE_AUTO_KEY);
    autoInfo = { status: 'empty' };
    lastSnapshot = null;
    updateSaveButtons();
  }

  function migrateLegacySave() {
    const legacy = readSaveAt(LEGACY_SAVE_KEY);
    if (legacy.status === 'empty') return;
    if (legacy.status === 'corrupt') {
      safeRemoveItem(LEGACY_SAVE_KEY);
      pushSaveNotice('旧存档已损坏，已清除');
      return;
    }
    if (autoInfo.status === 'ok') {
      // 已经有自动档：旧 v1 只做清理，避免反向覆盖新档
      safeRemoveItem(LEGACY_SAVE_KEY);
      return;
    }
    const env = makeSaveEnvelope('auto', legacy.save.snapshot, legacy.save.time || Date.now());
    const w = writeSaveAt(SAVE_AUTO_KEY, env);
    if (w.ok) {
      autoInfo = { status: 'ok', save: env, bytes: w.bytes };
      safeRemoveItem(LEGACY_SAVE_KEY);
    } else {
      pushSaveNotice('旧存档迁移失败：存储空间不足');
    }
  }

  function saveSlotFromSnapshot(slot, snap) {
    const index = Number(slot) - 1;
    if (index < 0 || index >= SAVE_SLOT_KEYS.length) return { ok: false, bytes: 0 };
    if (!snap) return { ok: false, bytes: 0 };
    const env = makeSaveEnvelope('manual', snap);
    const w = writeSaveAt(SAVE_SLOT_KEYS[index], env);
    if (!w.ok) {
      UI.toast('保存失败：存储空间不足或浏览器限制', true);
      return { ok: false, bytes: 0 };
    }
    slotInfo[index] = { status: 'ok', save: env, bytes: w.bytes };
    updateSaveButtons();
    return { ok: true, bytes: w.bytes };
  }

  function deleteSaveSlot(slot) {
    if (slot === 'auto') {
      clearAuto();
      return true;
    }
    const index = Number(slot) - 1;
    if (index < 0 || index >= SAVE_SLOT_KEYS.length) return false;
    safeRemoveItem(SAVE_SLOT_KEYS[index]);
    slotInfo[index] = { status: 'empty' };
    updateSaveButtons();
    return true;
  }

  function saveStats() {
    const slots = SAVE_SLOT_KEYS.map(function (key) {
      const raw = safeGetItem(key);
      return raw ? byteLength(raw) : 0;
    });
    const autoRaw = safeGetItem(SAVE_AUTO_KEY);
    const autoBytes = autoRaw ? byteLength(autoRaw) : 0;
    return { auto: autoBytes, slots: slots, total: autoBytes + slots.reduce(function (a, b) { return a + b; }, 0) };
  }

  function loadAuto() {
    const r = readSaveAt(SAVE_AUTO_KEY);
    if (r.status === 'corrupt') {
      safeRemoveItem(SAVE_AUTO_KEY);
      autoInfo = { status: 'empty' };
      updateSaveButtons();
      UI.toast('存档损坏，已清除', true);
      return;
    }
    if (r.status !== 'ok') { UI.toast('没有可继续的存档', true); return; }
    loadGame(r.save, SAVE_AUTO_KEY);
  }

  function loadSlot(slot) {
    const index = Number(slot) - 1;
    if (index < 0 || index >= SAVE_SLOT_KEYS.length) return;
    const key = SAVE_SLOT_KEYS[index];
    const r = readSaveAt(key);
    if (r.status === 'corrupt') {
      safeRemoveItem(key);
      slotInfo[index] = { status: 'empty' };
      updateSaveButtons();
      pushSaveNotice('存档损坏，已清除');
      UI.toast('存档损坏，已清除', true);
      return;
    }
    if (r.status !== 'ok') { UI.toast('该槽位没有存档', true); return; }
    loadGame(r.save, key);
  }

  function loadGame(save, sourceKey) {
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
    battleBgmOn = false;
    try { UI.setTrust(false); } catch (e) { /* ignore */ }
    let game = null;
    game = new SGS.Game({
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
        if (g.over) clearAuto();
      },
      onSnapshot: function (s) {
        if (mySession !== session) return;
        lastSnapshot = s;
        saveAuto(s);
      },
    });
    game.agents = buildAgents(game, n, {}, mySession, paceCfg(menu.pace).ai);
    try { if (global.SGS_AUDIO) global.SGS_AUDIO.playBgm('battle'); } catch (e) { /* ignore */ }
    UI.bindGame(game);
    try {
      game.restore(snap);
    } catch (e) {
      console.error('[SGS] 读档失败', e);
      if (sourceKey) safeRemoveItem(sourceKey);
      if (sourceKey === SAVE_AUTO_KEY) autoInfo = { status: 'empty' };
      else if (sourceKey) {
        const idx = SAVE_SLOT_KEYS.indexOf(sourceKey);
        if (idx >= 0) slotInfo[idx] = { status: 'empty' };
      }
      updateSaveButtons();
      UI.toast('存档损坏，无法继续', true);
      UI.showScreen('menu');
      return;
    }
    if (save.meta && save.meta.marks && UI.applySeatMarks) {
      try { UI.applySeatMarks(save.meta.marks); } catch (e) { /* 标记恢复失败不影响读档 */ }
    }
    UI.render(game);
    // 手动档读入后，自动档从这一局继续滚动；同时让 lastSnapshot 立即可用
    lastSnapshot = game.snapshot();
    saveAuto(lastSnapshot, { silent: true });
    game.resume().then(function () {
      if (mySession !== session) return;
      UI.render(game);
    }).catch(function (err) {
      if (mySession !== session) return;
      console.error('[SGS] 读档异常', err);
      UI.showError(err);
    });
  }

  /* ============================================================
     存档面板（保存 / 读取）
     ============================================================ */
  function ensureSavesPanel() {
    if (savesPanelEl && document.body.contains(savesPanelEl)) return savesPanelEl;
    const el = document.createElement('div');
    el.id = 'saves-panel';
    el.className = 'saves-panel';
    el.innerHTML =
      '<div class="saves-mask" data-saves-close="1"></div>' +
      '<div class="saves-dialog" role="dialog" aria-modal="true" aria-labelledby="saves-title">' +
      '  <div class="saves-head"><h3 id="saves-title">存档</h3>' +
      '    <button id="saves-close" class="saves-x" type="button" aria-label="关闭">×</button></div>' +
      '  <p class="saves-sub" id="saves-sub"></p>' +
      '  <div class="saves-list" id="saves-list"></div>' +
      '  <div class="saves-foot"><button id="saves-cancel" class="btn btn-outline" type="button">关闭</button></div>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener('click', onSavesPanelClick);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && savesPanelMode) { closeSavesPanel(); }
    });
    savesPanelEl = el;
    return el;
  }

  function saveRowHTML(slot, name, info) {
    const ok = info && info.status === 'ok' && info.save;
    let meta = '空槽位';
    if (ok) {
      const m = info.save.meta || {};
      meta = modeLabel(info.save.mode) + ' · 第 ' + (m.turn || 1) + ' 回合 · ' + (m.general || '—') +
        ' · ' + formatSaveTime(info.save.time) + ' · ' + Math.max(1, Math.round((info.bytes || 0) / 1024)) + 'KB';
    } else if (info && info.status === 'corrupt') {
      meta = '存档损坏';
    }
    const pending = pendingSlotAction && String(pendingSlotAction.slot) === String(slot);
    let acts = '';
    if (savesPanelMode === 'save') {
      if (slot !== 'auto') {
        acts = '<button type="button" class="saves-btn primary" data-act="save" data-slot="' + slot + '">' +
          (ok ? (pending && pendingSlotAction.type === 'overwrite' ? '确认覆盖' : '覆盖保存') : '保存') + '</button>';
      }
    } else if (ok) {
      acts = '<button type="button" class="saves-btn" data-act="load" data-slot="' + slot + '">读取</button>' +
        '<button type="button" class="saves-btn danger" data-act="delete" data-slot="' + slot + '">' +
        (pending && pendingSlotAction.type === 'delete' ? '确认删除' : '删除') + '</button>';
    }
    return '<div class="save-row' + (ok ? '' : ' is-empty') + '" data-slot="' + slot + '">' +
      '<div class="save-main"><b>' + name + '</b><span>' + meta + '</span></div>' +
      '<div class="save-acts">' + acts + '</div></div>';
  }

  function renderSavesPanel() {
    const el = ensureSavesPanel();
    if (!el) return;
    const isSave = savesPanelMode === 'save';
    const title = el.querySelector('#saves-title');
    const sub = el.querySelector('#saves-sub');
    const list = el.querySelector('#saves-list');
    if (title) title.textContent = isSave ? '保存进度' : '读取存档';
    if (sub) sub.textContent = isSave
      ? '保存的是本回合开始时的进度；覆盖已有槽位需要再次确认。'
      : '可读取自动存档或任意手动槽位；删除需要再次确认。';
    let html = '';
    if (!isSave) html += saveRowHTML('auto', '自动存档', autoInfo);
    for (let i = 0; i < SAVE_SLOT_KEYS.length; i++) html += saveRowHTML(String(i + 1), '槽位 ' + (i + 1), slotInfo[i]);
    if (list) list.innerHTML = html;
    el.classList.add('is-open');
  }

  function openSavesPanel(mode) {
    savesPanelMode = mode === 'save' ? 'save' : 'load';
    pendingSlotAction = null;
    if (pendingSlotTimer) { clearTimeout(pendingSlotTimer); pendingSlotTimer = 0; }
    const before = saveNotices.length;
    refreshAllSaves();
    if (saveNotices.length > before) {
      const notice = saveNotices[saveNotices.length - 1];
      saveNotices = [];
      try { UI.toast(notice, true); } catch (e) { /* ignore */ }
    }
    renderSavesPanel();
    const close = savesPanelEl && savesPanelEl.querySelector('#saves-close');
    if (close && close.focus) { try { close.focus(); } catch (e) { /* ignore */ } }
  }

  function closeSavesPanel() {
    if (savesPanelEl) savesPanelEl.classList.remove('is-open');
    savesPanelMode = null;
    pendingSlotAction = null;
    if (pendingSlotTimer) { clearTimeout(pendingSlotTimer); pendingSlotTimer = 0; }
  }

  function setPendingSlotAction(type, slot) {
    pendingSlotAction = { type: type, slot: slot, until: Date.now() + 4000 };
    if (pendingSlotTimer) clearTimeout(pendingSlotTimer);
    pendingSlotTimer = setTimeout(function () {
      pendingSlotTimer = 0;
      pendingSlotAction = null;
      if (savesPanelMode) renderSavesPanel();
    }, 4000);
    renderSavesPanel();
  }

  function onSavesPanelClick(e) {
    if (e.target.closest && e.target.closest('[data-saves-close],#saves-close,#saves-cancel')) {
      closeSavesPanel();
      return;
    }
    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const act = btn.dataset.act;
    const slot = btn.dataset.slot;
    if (act === 'load') {
      closeSavesPanel();
      if (slot === 'auto') loadAuto(); else loadSlot(Number(slot));
      return;
    }
    if (act === 'save') {
      const idx = Number(slot) - 1;
      const occupied = slotInfo[idx] && slotInfo[idx].status === 'ok';
      const armed = pendingSlotAction && pendingSlotAction.type === 'overwrite' && String(pendingSlotAction.slot) === String(slot);
      if (occupied && !armed) { setPendingSlotAction('overwrite', slot); return; }
      if (!lastSnapshot) { UI.toast('本回合刚开始，暂无可保存进度', true); return; }
      const r = saveSlotFromSnapshot(Number(slot), lastSnapshot);
      if (r.ok) {
        pendingSlotAction = null;
        UI.toast('已保存到槽位 ' + slot + '（本回合开始进度）');
        renderSavesPanel();
      }
      return;
    }
    if (act === 'delete') {
      const armed = pendingSlotAction && pendingSlotAction.type === 'delete' && String(pendingSlotAction.slot) === String(slot);
      if (!armed) { setPendingSlotAction('delete', slot); return; }
      pendingSlotAction = null;
      deleteSaveSlot(slot);
      UI.toast(slot === 'auto' ? '已删除自动存档' : ('已删除槽位 ' + slot));
      renderSavesPanel();
    }
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
    const btnSaves = q('btn-saves');
    if (btnSaves) btnSaves.addEventListener('click', function () { openSavesPanel('load'); });
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
    // 演示完全不读写玩家存档；正常新游戏只覆盖自动档，手动槽位一律保留
    if (!opts.demo) clearAuto();
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
        if (g.over && !opts.demo) clearAuto();
      },
      onSnapshot: function (snap) {
        if (mySession !== session) return;
        if (opts.demo) return; // 自动演示不写任何存档
        lastSnapshot = snap;
        saveAuto(snap);
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

  // 手动暂停统一入口：冻结引擎/读秒，保留 BGM（不变量 4）
  function pauseGame() {
    const st = UI._state && UI._state();
    if (!st || !st.game || !st.game.started || st.game.over) return;
    if (global.SGS_APP_PAUSE) global.SGS_APP_PAUSE(true, { keepAudio: true });
  }

  /* ============================================================
     入口
     ============================================================ */
  function boot() {
    const bootParams = new URLSearchParams(global.location.search);
    if (bootParams.has('nofx')) document.body.classList.add('no-anim');
    UI.init({
      onPause: pauseGame,
      onQuit: function () {
        if (UI._state && UI._state().game && !UI._state().game.over) {
          UI.confirmDialog('退出本局将判负，确定返回主菜单？', function () {
            clearAuto(); // 判负退出只清自动档，手动槽位保留
            UI.surrender();
            session += 1;
            UI.showScreen('menu');
            try { if (global.SGS_AUDIO) global.SGS_AUDIO.playBgm('menu'); } catch (e) { /* ignore */ }
          }, { okText: '退出', danger: true });
          return;
        }
        session += 1;
        try { if (global.SGS_AUDIO) global.SGS_AUDIO.playBgm('menu'); } catch (e) { /* ignore */ }
        UI.showScreen('menu');
      },
      onSave: function () {
        if (!lastSnapshot) { UI.toast('本回合刚开始，暂无可保存进度', true); return; }
        openSavesPanel('save');
      },
      onContinue: function () { loadAuto(); },
      onSurrender: function () {
        UI.confirmDialog('确定投降？本局将判负。', function () {
          clearAuto(); // 投降判负只清自动档，手动槽位保留
          UI.surrender();
        }, { okText: '投降', danger: true });
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
        clearAuto(); // 对局结束回主菜单：只清自动档
        session += 1;
        try { if (global.SGS_AUDIO) global.SGS_AUDIO.playBgm('menu'); } catch (e) { /* ignore */ }
        UI.showScreen('menu');
      },
    });

    global.SGS_BACK = function () {
      try {
        const st = UI._state();
        if (!st) return false;
        const d = global.document;
        if (!d) return false;
        // 存档面板最上层，先关闭
        if (savesPanelMode) { closeSavesPanel(); return true; }
        // 「更多」菜单最上层，先关闭
        const mm = d.getElementById('more-menu');
        if (mm && mm.classList.contains('is-open')) {
          const mb = d.getElementById('btn-more');
          if (mb) mb.click();
          return true;
        }
        // 暂停遮罩、详情、设置、战报优先关闭
        const resume = d.getElementById('resume-overlay');
        if (resume && resume.classList.contains('is-on')) return true;
        const gi = d.querySelector('.general-info-mask [data-gi-close]');
        if (gi) { gi.click(); return true; }
        if (d.querySelector('.settings-panel.is-open')) {
          const sc = d.getElementById('btn-settings-close'); if (sc) sc.click();
          return true;
        }
        if (UI.isLogOpen && UI.isLogOpen()) {
          const lc = d.getElementById('btn-log-close'); if (lc) lc.click();
          return true;
        }
        // 选目标/选牌中的“取消”优先消费返回键，避免直接弹退出确认
        const pickCancel = d.querySelector('#pick-bar [data-pick="cancel"]');
        if (pickCancel) { pickCancel.click(); return true; }
        const playCancel = d.querySelector('#action-bar [data-act="play-cancel"]');
        if (playCancel) { playCancel.click(); return true; }
        if (d.querySelector('.modal-mask')) {
          // 选择/确认弹窗不能用返回键退出，避免误放弃强制选择
          return true;
        }
        if (st.screen === 'result') { UI.showScreen('menu'); return true; }
        if (st.screen === 'select') {
          const sb = d.getElementById('btn-select-back'); if (sb) sb.click();
          return true;
        }
        if (st.screen === 'game') {
          const bq = d.getElementById('btn-quit'); if (bq) bq.click();
          return true;
        }
        return false;
      } catch (e) { return false; }
    };

    global.SGS_APP_PAUSE = function (paused, opts) {
      opts = opts || {};
      try {
        if (global.console) global.console.log('[SGS_PAUSE]', !!paused, opts);
        global.__SGS_LAST_PAUSE = !!paused;
        const st = UI._state();
        if (st && st.game && st.game.setPaused) st.game.setPaused(!!paused);
        try { paused ? UI.pauseCountdown() : UI.resumeCountdown(); } catch (e) { /* ignore */ }
        if (global.SGS_AUDIO && (paused ? !opts.keepAudio : true)) {
          try { paused ? global.SGS_AUDIO.suspend() : global.SGS_AUDIO.resume(); } catch (e) { /* ignore */ }
        }
        const ov = document.getElementById('resume-overlay');
        if (ov) {
          const show = !!paused && st && st.screen === 'game' && st.game && st.game.started && !st.game.over;
          ov.classList.toggle('is-on', show);
          const ti = document.getElementById('resume-title');
          const su = document.getElementById('resume-sub');
          if (ti) ti.textContent = '游戏已暂停';
          if (su) su.textContent = opts.keepAudio ? '牌局与读秒已暂停，背景音乐继续' : '离开应用期间牌局已冻结';
        }
      } catch (e) { /* ignore */ }
    };
    if (global.document) {
      global.document.addEventListener('visibilitychange', function () {
        // 只暂停；恢复必须由玩家点“继续游戏”，避免恢复瞬间快进
        if (global.document.hidden && global.SGS_APP_PAUSE) global.SGS_APP_PAUSE(true);
      });
    }
    const btnResume = q('btn-resume');
    if (btnResume) btnResume.addEventListener('click', function () {
      if (global.SGS_APP_PAUSE) global.SGS_APP_PAUSE(false);
    });
    const muteCb = q('set-mute');
    if (muteCb) {
      muteCb.checked = !!readSettings().mute;
      muteCb.addEventListener('change', function () { applyMute(!!muteCb.checked, true); });
    }
    const settingsBtn = q('btn-settings');
    if (settingsBtn) settingsBtn.addEventListener('click', syncMuteSwitch);
    applyMute(!!readSettings().mute, false);
    bindMenu();
    updateMenuUI();
    refreshAllSaves();
    migrateLegacySave();
    updateSaveButtons();
    if (saveNotices.length) {
      const notice = saveNotices[0];
      saveNotices = [];
      setTimeout(function () { try { UI.toast(notice, true); } catch (e) { /* ignore */ } }, 350);
    }

    const params = new URLSearchParams(global.location.search);
    if (params.get('screen') === 'home' || params.get('screen') === 'menu') {
      UI.showScreen('menu');
      return;
    }
    readParams();
  }

  // 存档测试/调试接口（qa_e2e 使用；不参与正常游戏流程）
  global.SGS_SAVE = {
    version: SAVE_VERSION,
    keys: { auto: SAVE_AUTO_KEY, slots: SAVE_SLOT_KEYS.slice(), legacy: LEGACY_SAVE_KEY },
    refresh: function () { refreshAllSaves(); return saveStats(); },
    stats: saveStats,
    readAuto: function () {
      const r = readSaveAt(SAVE_AUTO_KEY);
      return r.status === 'ok' ? r.save : null;
    },
    readSlot: function (n) {
      const i = Number(n) - 1;
      if (i < 0 || i >= SAVE_SLOT_KEYS.length) return null;
      const r = readSaveAt(SAVE_SLOT_KEYS[i]);
      return r.status === 'ok' ? r.save : null;
    },
    saveSlot: function (n) { return saveSlotFromSnapshot(n, lastSnapshot); },
    deleteSlot: deleteSaveSlot,
    clearAuto: clearAuto,
    openSavePanel: function () { openSavesPanel('save'); },
    openLoadPanel: function () { openSavesPanel('load'); },
    closePanel: closeSavesPanel,
    migrateLegacy: migrateLegacySave,
    lastSnapshotBytes: function () {
      try { return lastSnapshot ? byteLength(JSON.stringify(lastSnapshot)) : 0; } catch (e) { return 0; }
    },
  };

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
