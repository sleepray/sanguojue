/* 三国杀 · 单机版 — Web 对局界面
 * 纯原生 DOM，不依赖任何框架。所有交互只通过引擎 request / answer 协议。
 */
(function (global) {
  'use strict';

  const D = global.SGS_DATA || {};
  const CARDS = D.CARDS || {};
  const SUITS = D.SUITS || {};
  const SKILLS = D.SKILLS || {};

  const PHASE_CN = {
    init: '准备', start: '准备阶段', judge: '判定阶段', draw: '摸牌阶段',
    play: '出牌阶段', discard: '弃牌阶段', end: '结束阶段',
  };
  const TYPE_TITLE = {
    chooseGeneral: '选择武将', play: '出牌阶段', response: '请响应',
    chooseCards: '选择牌', chooseTargets: '选择目标', chooseOption: '请选择',
    chooseCardFrom: '选择一张牌', arrange: '调整牌序', pickFrom: '选择一张牌',
    chooseHiddenCard: '选择手牌',
    distribute: '分配手牌',
  };
  const SLOTS = ['weapon', 'armor', 'offhorse', 'defhorse'];
  const SLOT_CN = { weapon: '武器', armor: '防具', offhorse: '-1 马', defhorse: '+1 马' };
  const SLOT_GLYPH = { weapon: '武', armor: '防', offhorse: '−', defhorse: '+' };
  const JUDGE_SHORT = { lebu: '乐', bingliang: '兵', shandian: '电' };

  // 对手座位坐标（百分比，围绕上方与左右两侧）
  const POS_8 = [[12, 74], [11, 31], [30, 26], [50, 26], [70, 26], [89, 31], [88, 74]];
  const POS_5 = [[15, 72], [34, 26], [66, 26], [85, 72]];
  const POS_1 = [[50, 25]];
  const POS_2 = [[26, 25], [74, 25]];
  const POS_4 = [[22, 62], [50, 26], [78, 62]];
  const POS_6 = [[8, 62], [28, 26], [50, 25], [72, 26], [92, 62]];
  const POS_8_P = [[9, 80], [9, 45], [24, 26], [50, 26], [76, 26], [91, 45], [91, 80]];
  const POS_5_P = [[12, 72], [28, 26], [72, 26], [88, 72]];
  const POS_4_P = [[20, 65], [50, 26], [80, 65]];
  const POS_6_P = [[8, 70], [26, 26], [50, 25], [74, 26], [92, 70]];
  const POS_2_P = [[22, 26], [78, 26]];
  const POS_8_L = [[6, 78], [6, 32], [22, 26], [50, 26], [78, 26], [94, 32], [94, 78]];
  const POS_5_L = [[6, 76], [24, 28], [76, 28], [94, 76]];
  const POS_4_L = [[18, 70], [50, 28], [82, 70]];
  const POS_6_L = [[5, 74], [22, 28], [50, 28], [78, 28], [95, 74]];
  const POS_2_L = [[22, 30], [78, 30]];

  const els = {};
  const seatEls = new Map();
  const last = {
    handSig: '', skillSig: '', equipSig: '', judgeSig: '__init__',
    logLen: -1, logTail: null, recentLen: 0, tableSig: '',
    sfxLogLen: 0, sfxLogTail: null, judgeSig: '', judgeAt: 0,
    judgeLogLen: 0, judgeLogTail: null,
    flowLogLen: 0, flowLogTail: null,
    hp: {}, actionHTML: '', modalHTML: '',
  };

  let game = null;
  let seatGame = null;
  let humanSeat = 0;
  let screen = 'menu';
  let pending = null;
  let hooks = {};
  let selectIdx = -1;
  let selectSig = '';
  const sel = { action: null, cards: [], targets: [] };
  let respSel = null;
  let respCardId = null;
  let chooser = null;
  let modalReq = null;
  let m = null;
  let fatalError = null;
  let lastFatalHTML = '';
  let resultFor = null;
  let seatMarks = {};
  let hoverSeat = null;
  let tablePick = null;
  let confirmOpen = false;
  let transientAim = [];
  let flashAimTimer = 0;
  const SETTINGS_KEY = 'sgs.settings.v1';
  let countdownTimer = 0;
  let countdownEnd = 0;
  let countdownReq = null;
  let countdownPaused = false;
  let countdownRemainMs = 0;
  let pindianTimer = 0;
  let effectsGame = null;
  let tooltipEl = null;
  let generalInfoOpen = false;
  let seatPressTimer = 0;
  let seatPressInfo = null;
  let suppressSeatClick = { seat: null, until: 0 };
  let selfPress = false;
  let suppressSelfClickUntil = 0;
  let handPressTimer = 0;
  let handPressInfo = null;
  let suppressHandClickUntil = 0;
  let meArtKey = '';
  let handDirty = false;
  let logOpen = false;
  let settingsOpen = false;
  let toastSeq = 0;
  let lastAnswer = null;
  let lastPhaseShown = null;
  let phaseTimer = 0;
  let heldBarHTML = '';
  let holdUntil = 0;
  let holdTimer = 0;
  let skillBannerTimer = 0;
  let pickState = null;
  let wuguState = null;
  let wuguTimer = 0;
  let flowQueue = [];
  let flowPumpTimer = 0;
  let revealQueue = [];
  let revealTimer = 0;
  let revealShowing = false;
  let lastTrick = null;
  let judgeQueue = [];
  let judgeTimer = 0;
  let judgeShowing = false;
  let handLayoutTimer = 0;
  let logNewCount = 0;

  /* ============================================================
     基础工具
     ============================================================ */
  function q(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cardDef(name) { return CARDS[name] || { name: name || '？', pinyin: 'sha', type: 'basic', desc: '' }; }
  function cardImg(name) { const d = cardDef(name); return d && d.noArt ? '' : ('assets/cards/' + d.pinyin + '.png'); }
  function cardImgOf(c) { return cardImg(c && c.name); }
  function cardImgTag(c) { const src = cardImgOf(c); return src ? '<img src="' + src + '" alt="" onerror="this.onerror=null;this.style.display=&quot;none&quot;">' : '<span class="card-noimg"></span>'; }
  function cardCornersHTML(c) {
    const s = suitOf(c);
    if (!s) return '';
    const rank = rankCn(c.rank);
    const color = s.color === 'red' ? '#b3261e' : '#1b1b1b';
    return '<span class="card-corner cc-tl" style="color:' + color + '">' + s.cn + '<b>' + esc(rank) + '</b></span>' +
      '<span class="card-corner cc-br" style="color:' + color + '">' + s.cn + '<b>' + esc(rank) + '</b></span>';
  }
  function seatImg(id) { return 'assets/seat/' + String(id).padStart(3, '0') + '.png'; }
  function bigImg(id) { return 'assets/big/' + String(id).padStart(3, '0') + '.png'; }
  function kingdomColor(k) { return (D.KINGDOM_COLOR || {})[k] || '#6b6250'; }
  function displayName(p) {
    if (!p) return '无人';
    if (p.general) return p.general.name;
    return p.isHuman ? '你' : (p.name || ('玩家' + (p.seat + 1)));
  }
  function rankCn(r) { return (D.RANK_CN || {})[r] || (r || ''); }
  function suitOf(c) { return c && SUITS[c.suit] ? SUITS[c.suit] : null; }
  function suitColor(c) {
    const s = suitOf(c);
    return s && s.color === 'red' ? '#ff8270' : '#e9e1cf';
  }
  function skillName(id) { return (SKILLS[id] && SKILLS[id].name) || id; }
  function skillDesc(id) { return (SKILLS[id] && SKILLS[id].desc) || ''; }
  function typeCn(def) {
    if (!def) return '';
    if (def.type === 'basic') return '基本牌';
    if (def.type === 'trick') return '锦囊牌';
    if (def.type === 'delayed') return '延时锦囊';
    if (def.type === 'equip') return '装备牌 · ' + (SLOT_CN[def.subtype] || '');
    return '';
  }
  function cardTip(c) {
    if (!c) return '';
    const def = cardDef(c.name);
    const s = suitOf(c);
    const rank = rankCn(c.rank);
    const head = '【' + def.name + '】' + (s ? ' ' + s.cn + rank : '');
    const extra = [];
    if (def.type === 'equip' && def.range) extra.push('攻击范围 ' + def.range);
    return head + ' · ' + typeCn(def) + (extra.length ? ' · ' + extra.join(' · ') : '') + '\n' + (def.desc || '');
  }
  function hpClass(hp, maxHp) { return hp >= maxHp ? ' is-healthy' : ''; }
  function beadsHTML(hp, maxHp, extra) {
    const max = Math.max(1, maxHp || 1);
    let h = '<span class="beads">';
    for (let i = 0; i < max; i++) {
      h += '<i class="bead' + (i < hp ? ' on' : '') + (extra || '') + '"></i>';
    }
    return h + '</span>';
  }
  function setHTML(el, html) {
    if (!el) return;
    if (el._lastHTML === html) return;
    el._lastHTML = html;
    el.innerHTML = html;
  }
  function toast(text, warn) {
    if (!els.toastRoot || !text) return;
    const node = document.createElement('div');
    node.className = 'toast' + (warn ? ' is-warn' : '');
    node.textContent = text;
    els.toastRoot.appendChild(node);
    const id = ++toastSeq;
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
      if (id === toastSeq) { /* no-op */ }
    }, 2600);
  }
  function playSfxKey(key) {
    try {
      const A = global.SGS_AUDIO;
      if (A && typeof A.play === 'function') A.play(key);
    } catch (e) { /* 静默 */ }
  }

  function sfx(name, arg1, arg2, arg3) {
    try {
      const A = global.SGS_AUDIO;
      if (!A || typeof A[name] !== 'function') return;
      if (name === 'playGeneral') A.playGeneral(arg1, arg2, arg3);
      else A[name](arg1, arg2);
    } catch (e) { /* 音效失败静默 */ }
  }

  /* ============================================================
     提示气泡
     ============================================================ */
  function showTip(text, target) {
    if (!tooltipEl || !text || !target) return;
    tooltipEl.textContent = text;
    tooltipEl.classList.add('is-on');
    const r = target.getBoundingClientRect();
    const w = Math.min(window.innerWidth <= 700 ? 280 : 330, window.innerWidth - 24);
    tooltipEl.style.width = w + 'px';
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(12, Math.min(window.innerWidth - w - 12, left));
    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = (r.bottom + 9) + 'px';
    const h = tooltipEl.offsetHeight;
    let top = r.bottom + 9;
    if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 9);
    tooltipEl.style.top = top + 'px';
  }
  function hideTip() { if (tooltipEl) tooltipEl.classList.remove('is-on'); }

  /* ---------- 武将详情：长按 550ms / 右键 ---------- */
  function closeGeneralInfo() {
    generalInfoOpen = false;
    if (els.generalInfoRoot) els.generalInfoRoot.innerHTML = '';
  }

  function cancelSeatPress() {
    if (seatPressTimer) { clearTimeout(seatPressTimer); seatPressTimer = 0; }
    seatPressInfo = null;
    selfPress = false;
  }

  function isMobileActionUI() {
    return global.innerWidth <= 1100;
  }

  function canMarkSeat(seat) {
    if (!game || !game.players || !game.players[seat]) return false;
    const p = game.players[seat];
    return game.mode !== '1v1' && !game.ddzMode && !game.teamMode && !game.over &&
      p.alive && p.role !== 'lord' && !p.revealed;
  }

  function openSeatAction(seat) {
    if (isMobileActionUI() && canMarkSeat(seat)) openRoleMark(seat);
    else openGeneralInfo(seat);
  }

  function openRoleMark(seat) {
    if (!game || !game.players || !game.players[seat] || !els.generalInfoRoot) return;
    const p = game.players[seat];
    const gen = p.general;
    const cur = seatMarks[seat] || '';
    const opts = [
      { id: 'loyalist', label: '忠臣' },
      { id: 'rebel', label: '反贼' },
      { id: 'renegade', label: '内奸' },
    ];
    const body = '<div class="role-mark-target">' + esc(gen ? gen.name : displayName(p)) +
      ' · 身份未知 · 仅自己可见</div>' +
      '<div class="role-mark-options">' + opts.map(function (o) {
        return '<button class="role-mark-btn' + (cur === o.id ? ' is-on' : '') +
          '" data-role-mark="' + o.id + '" data-seat="' + seat + '">' + o.label + '</button>';
      }).join('') +
      '<button class="role-mark-btn is-clear' + (!cur ? ' is-on' : '') +
        '" data-role-mark="" data-seat="' + seat + '">清空</button></div>' +
      '<div class="role-mark-hint">长按敌方座位可再次调整标记</div>';
    els.generalInfoRoot.innerHTML = '<div class="modal-mask general-info-mask">' +
      '<div class="modal role-mark-modal" role="dialog" aria-modal="true" aria-label="身份标记">' +
      '<div class="modal-head"><span class="modal-title">身份标记</span>' +
      '<button class="gi-close" data-gi-close aria-label="关闭">×</button></div>' +
      '<div class="modal-body">' + body + '</div>' +
      '<div class="modal-foot">' +
      '<button class="btn btn-outline" data-gi-info="' + seat + '" style="margin-right:auto">武将详情</button>' +
      '<button class="btn btn-outline" data-gi-close>关闭</button></div>' +
      '</div></div>';
    generalInfoOpen = true;
  }

  function openGeneralInfo(seat) {
    if (!game || !game.players || !game.players[seat]) return;
    const p = game.players[seat];
    const gen = p.general;
    const name = gen ? gen.name : displayName(p);
    const kingdom = p.kingdom || (gen && gen.kingdom) || '—';
    const color = kingdomColor(kingdom);
    const title = gen && gen.title ? gen.title : '—';
    const role = roleLabelFor(game, p) || '？';
    const hp = Math.max(0, p.hp) + ' / ' + p.maxHp;
    const roleCls = roleClassOf(game, p);
    let skills = (p.skills && p.skills.length) ? p.skills.slice() : ((gen && gen.skills) ? gen.skills.slice() : []);
    skills = skills.filter(function (id, i) { return skills.indexOf(id) === i; });
    const skillHTML = skills.length ? skills.map(function (id) {
      const desc = skillDesc(id) || '暂无描述';
      return '<div class="gi-skill"><b>' + esc(skillName(id)) + '</b><p>' + esc(desc) + '</p></div>';
    }).join('') : '<div class="gi-empty">暂无技能</div>';
    const art = gen
      ? '<img src="' + bigImg(gen.id) + '" alt="" onerror="this.onerror=null;this.src=\'' + seatImg(gen.id) + '\'">'
      : '<div class="gi-empty" style="padding:22px;text-align:center">未选择武将</div>';
    // 当前装备 / 判定 / 手牌数 / 状态
    const equipped = SLOTS.filter(function (slot) { return p.equips && p.equips[slot]; });
    const equipChips = equipped.length ? equipped.map(function (slot) {
      const c = p.equips[slot];
      const su = suitOf(c);
      return '<span class="gi-chip"><b>' + esc(SLOT_CN[slot]) + '</b> ' + esc(cardDef(c.name).name) +
        (su ? '<em style="color:' + (su.color === 'red' ? '#ff8270' : '#e9e1cf') + '">' + su.cn + rankCn(c.rank) + '</em>' : '') + '</span>';
    }).join('') : '<span class="gi-chip is-empty">无</span>';
    const judgeChips = (p.judges || []).length
      ? p.judges.map(function (c) { return '<span class="gi-chip">' + esc(cardDef(c.name).name) + '</span>'; }).join('')
      : '<span class="gi-chip is-empty">无</span>';
    const liveHTML = '<div class="gi-live">' +
      (equipped.length ? '<div class="gi-live-row"><span class="gi-live-label">装备</span><div class="gi-live-chips">' + equipChips + '</div></div>' : '') +
      '<div class="gi-live-row"><span class="gi-live-label">判定</span><div class="gi-live-chips">' + judgeChips + '</div></div>' +
      '<div class="gi-live-row"><span class="gi-live-label">手牌</span><div class="gi-live-chips"><span class="gi-chip">' + (p.hand ? p.hand.length : 0) + ' 张</span>' +
      (p.chained ? '<span class="gi-chip is-warn">横置</span>' : '') + (p.flipped ? '<span class="gi-chip is-warn">翻面</span>' : '') +
      (p.drank ? '<span class="gi-chip is-warn">酒</span>' : '') + '</div></div></div>';
    if (!els.generalInfoRoot) return;
    els.generalInfoRoot.innerHTML = '<div class="modal-mask general-info-mask">' +
      '<div class="modal general-info-modal" role="dialog" aria-modal="true" aria-label="武将详情">' +
      '<div class="modal-head"><span class="modal-title">武将详情</span>' +
      '<button class="gi-close" data-gi-close aria-label="关闭">×</button></div>' +
      '<div class="modal-body">' +
      '<div class="gi-top"><div class="gi-art">' + art + '</div>' +
      '<div class="gi-meta">' +
      '<div class="gi-name">' + esc(name) + '<em class="gi-k" style="--gi-k:' + color + '">' + esc(kingdom) + '</em></div>' +
      '<div class="gi-sub">称号 · ' + esc(title) + '</div>' +
      '<div class="gi-stats"><span>势力 <b>' + esc(kingdom) + '</b></span>' +
      '<span>体力 <b>' + hp + '</b></span>' +
      '<span class="gi-role ' + roleCls + '">身份 <b>' + esc(role) + '</b></span>' +
      (p.alive ? '' : '<span style="color:#e07062">已阵亡</span>') + '</div>' +
      '</div></div>' +
      liveHTML +
      '<div class="gi-skills">' + skillHTML + '</div>' +
      '</div>' +
      '<div class="modal-foot"><button class="btn btn-outline" data-gi-close>关闭</button></div>' +
      '</div></div>';
    generalInfoOpen = true;
  }

  function onGeneralInfoClick(e) {
    if (!generalInfoOpen) return;
    const mark = e.target.closest && e.target.closest('[data-role-mark]');
    if (mark) {
      e.preventDefault();
      e.stopPropagation();
      const seat = Number(mark.dataset.seat);
      const val = mark.dataset.roleMark;
      if (val) seatMarks[seat] = val;
      else delete seatMarks[seat];
      closeGeneralInfo();
      if (game) render(game);
      return;
    }
    const info = e.target.closest && e.target.closest('[data-gi-info]');
    if (info) {
      e.preventDefault();
      e.stopPropagation();
      openGeneralInfo(Number(info.dataset.giInfo));
      return;
    }
    const close = e.target.closest && e.target.closest('[data-gi-close]');
    const mask = e.target.classList && e.target.classList.contains('general-info-mask');
    if (close || mask) {
      e.preventDefault();
      e.stopPropagation();
      closeGeneralInfo();
    }
  }

  function onSeatPointerDown(e) {
    if (generalInfoOpen) return;
    if (e.button != null && e.button !== 0) return;
    const selfEl = e.target.closest ? e.target.closest('#me-portrait') : null;
    if (selfEl) {
      cancelSeatPress();
      hideTip();
      selfPress = true;
      seatPressInfo = { seat: humanSeat, x: e.clientX, y: e.clientY };
      seatPressTimer = setTimeout(function () {
        seatPressTimer = 0;
        seatPressInfo = null;
        selfPress = false;
        suppressSelfClickUntil = Date.now() + 1000;
        openGeneralInfo(humanSeat);
      }, 550);
      return;
    }
    selfPress = false;
    const seatEl = e.target.closest ? e.target.closest('.seat') : null;
    if (!seatEl) return;
    cancelSeatPress();
    hideTip();
    seatPressInfo = { seat: Number(seatEl.dataset.seat), x: e.clientX, y: e.clientY };
    seatPressTimer = setTimeout(function () {
      seatPressTimer = 0;
      const seat = seatPressInfo ? seatPressInfo.seat : null;
      seatPressInfo = null;
      if (seat == null) return;
      suppressSeatClick = { seat: seat, until: Date.now() + 1000 };
      hideTip();
      openSeatAction(seat);
    }, 550);
  }

  function onSeatPointerMove(e) {
    if (!seatPressInfo) return;
    if (Math.abs(e.clientX - seatPressInfo.x) > 8 || Math.abs(e.clientY - seatPressInfo.y) > 8) cancelSeatPress();
  }

  function onSeatPressEnd() {
    cancelSeatPress();
  }

  function onSeatContextMenu(e) {
    const seatEl = e.target.closest ? e.target.closest('.seat') : null;
    if (!seatEl) return;
    e.preventDefault();
    cancelSeatPress();
    hideTip();
    suppressSeatClick = { seat: Number(seatEl.dataset.seat), until: Date.now() + 800 };
    openSeatAction(Number(seatEl.dataset.seat));
  }

  function onSeatClickCapture(e) {
    if (!suppressSeatClick.seat || Date.now() > suppressSeatClick.until) {
      if (suppressSeatClick.seat) suppressSeatClick = { seat: null, until: 0 };
      return;
    }
    const seatEl = e.target.closest ? e.target.closest('.seat') : null;
    if (!seatEl || Number(seatEl.dataset.seat) !== suppressSeatClick.seat) return;
    suppressSeatClick = { seat: null, until: 0 };
    e.preventDefault();
    e.stopPropagation();
  }


  /* ============================================================
     初始化
     ============================================================ */
  function init(h) {
    hooks = h || {};
    els.app = q('app');
    els.screenMenu = q('screen-menu');
    els.screenSelect = q('screen-select');
    els.screenGame = q('screen-game');
    els.screenResult = q('screen-result');
    els.generalRow = q('general-row');
    els.selectRole = q('select-role');
    els.selectReason = q('select-reason');
    els.selectHint = q('select-hint');
    els.btnGeneralConfirm = q('btn-general-confirm');
    els.tbDeck = q('tb-deck');
    els.tbDiscard = q('tb-discard');
    els.tbTurn = q('tb-turn');
    els.tbPhase = q('tb-phase');
    els.tbPrompt = q('tb-prompt');
    els.tbCount = q('tb-count');
    els.handTimer = q('hand-timer');
    els.btnLog = q('btn-log');
    els.btnLogClose = q('btn-log-close');
    els.btnSettings = q('btn-settings');
    els.settingsPanel = q('settings-panel');
    els.btnSettingsClose = q('btn-settings-close');
    els.setBgm = q('set-bgm');
    els.setBgmVal = q('set-bgm-val');
    els.setSfx = q('set-sfx');
    els.setSfxVal = q('set-sfx-val');
    els.setAnim = q('set-anim');
    els.setPace = q('set-pace');
    els.btnQuit = q('btn-quit');
    els.btnSurrender = q('btn-surrender');
    els.btnTrust = q('btn-trust');
    els.btnSave = q('btn-save');
    els.btnContinue = q('btn-continue');
    els.phaseBanner = q('phase-banner');
    els.phaseBannerTitle = q('phase-banner-title');
    els.phaseBannerSub = q('phase-banner-sub');
    els.skillBanner = q('skill-banner');
    els.skillBannerTitle = q('skill-banner-title');
    els.skillBannerSub = q('skill-banner-sub');
    els.judgeOverlay = q('judge-overlay');
    els.judgeFace = q('judge-face');
    els.judgeImg = q('judge-img');
    els.judgeSuit = q('judge-suit');
    els.judgeRank = q('judge-rank');
    els.judgeName = q('judge-name');
    els.judgeReason = q('judge-reason');
    els.judgeWho = q('judge-who');
    els.judgeResult = q('judge-result');
    els.flowLayer = q('flow-layer');
    els.wuguTray = q('wugu-tray');
    els.wuguCards = q('wugu-cards');
    els.wuguCount = q('wugu-count');
    els.wuguPicker = q('wugu-picker');
    els.wuguLast = q('wugu-last');
    els.revealBox = q('reveal-box');
    els.revealCard = q('reveal-card');
    els.revealImg = q('reveal-img');
    els.revealSuit = q('reveal-suit');
    els.revealRank = q('reveal-rank');
    els.revealName = q('reveal-name');
    els.revealTitle = q('reveal-title');
    els.revealSub = q('reveal-sub');
    els.table = q('table');
    els.seats = q('seats');
    els.aim = q('aim-layer');
    els.dragon = q('dragon-layer');
    els.chain = q('chain-layer');
    els.phaseOrbit = q('phase-orbit');
    els.orbitPhase = q('orbit-phase');
    els.orbitSub = q('orbit-sub');
    els.orbitTimer = q('orbit-timer');
    els.played = q('played-cards');
    els.fx = q('fx-layer');
    els.mePortrait = q('me-portrait');
    els.meArt = q('me-art');
    els.meRole = q('me-role');
    els.meKingdom = q('me-kingdom');
    els.meName = q('me-name');
    els.meTitle = q('me-title');
    els.meStatus = q('me-status');
    els.meHp = q('me-hp');
    els.meSkills = q('me-skills');
    els.meEquips = q('me-equips');
    els.meJudges = q('me-judges');
    els.meMarks = q('me-marks');
    els.actionBar = q('action-bar');
    els.pickBar = q('pick-bar');
    els.hand = q('hand');
    els.chooser = q('card-chooser');
    els.logPanel = q('log-panel');
    els.logBody = q('log-body');
    els.logNew = q('log-new');
    els.modalRoot = q('modal-root');
    els.generalInfoRoot = q('general-info-root');
    els.toastRoot = q('toast-root');
    els.resultTitle = q('result-title');
    els.resultSub = q('result-sub');
    els.resultPlayers = q('result-players');
    els.btnAgain = q('btn-again');
    els.btnHome = q('btn-home');

    tooltipEl = document.createElement('div');
    tooltipEl.className = 'sgs-tooltip';
    document.body.appendChild(tooltipEl);

    bindEvents();
    loadSettings();
    showScreen('menu');
  }

  function loadSettings() {
    try {
      const raw = global.localStorage && global.localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const st = JSON.parse(raw) || {};
      const A = audioApi();
      if (A) {
        if (typeof st.bgm === 'number') A.bgmVolume = st.bgm / 100;
        if (typeof st.sfx === 'number') A.volume = st.sfx / 100;
      }
      if (st.anim === false) document.body.classList.add('reduce-motion');
      if (st.pace && hooks.onPaceChange) hooks.onPaceChange(st.pace);
    } catch (e) { /* ignore */ }
  }

  function saveSettings(patch) {
    try {
      const raw = global.localStorage && global.localStorage.getItem(SETTINGS_KEY);
      const st = raw ? (JSON.parse(raw) || {}) : {};
      Object.keys(patch).forEach(function (k) { st[k] = patch[k]; });
      global.localStorage.setItem(SETTINGS_KEY, JSON.stringify(st));
    } catch (e) { /* ignore */ }
  }

  function bindEvents() {
    els.hand.addEventListener('click', onHandClick);
    els.hand.addEventListener('pointerdown', onHandPressDown);
    els.hand.addEventListener('pointermove', onHandPressMove);
    els.hand.addEventListener('pointerup', onHandPressEnd);
    els.hand.addEventListener('pointercancel', onHandPressEnd);
    els.hand.addEventListener('pointerleave', onHandPressEnd);
    els.hand.addEventListener('contextmenu', onHandContextMenu);
    els.seats.addEventListener('click', onSeatsClick);
    els.seats.addEventListener('click', onSeatClickCapture, true);
    els.seats.addEventListener('pointerdown', onSeatPointerDown);
    els.seats.addEventListener('pointermove', onSeatPointerMove);
    els.seats.addEventListener('pointerup', onSeatPressEnd);
    els.seats.addEventListener('pointercancel', onSeatPressEnd);
    els.seats.addEventListener('pointerleave', onSeatPressEnd);
    els.seats.addEventListener('contextmenu', onSeatContextMenu);
    if (els.generalInfoRoot) els.generalInfoRoot.addEventListener('click', onGeneralInfoClick);
    els.mePortrait.addEventListener('click', function (e) {
      if (Date.now() < suppressSelfClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
      onSeatPick(humanSeat);
    });
    els.mePortrait.addEventListener('pointerdown', onSeatPointerDown);
    els.mePortrait.addEventListener('pointermove', onSeatPointerMove);
    els.mePortrait.addEventListener('pointerup', onSeatPressEnd);
    els.mePortrait.addEventListener('pointercancel', onSeatPressEnd);
    els.mePortrait.addEventListener('pointerleave', onSeatPressEnd);
    els.mePortrait.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      cancelSeatPress();
      suppressSelfClickUntil = Date.now() + 800;
      openGeneralInfo(humanSeat);
    });
    els.actionBar.addEventListener('click', onActionBarClick);
    if (els.pickBar) els.pickBar.addEventListener('click', onPickBarClick);
    if (els.logBody) els.logBody.addEventListener('scroll', onLogScroll);
    if (els.logNew) els.logNew.addEventListener('click', function () { els.logBody.scrollTop = els.logBody.scrollHeight; logNewCount = 0; showLogNew(0); });
    els.meSkills.addEventListener('click', onSkillClick);
    els.meEquips.addEventListener('click', onEquipClick);
    els.generalRow.addEventListener('click', onGeneralClick);
    els.btnGeneralConfirm.addEventListener('click', onGeneralConfirm);
    els.modalRoot.addEventListener('click', onModalClick);
    els.chooser.addEventListener('click', onChooserClick);
    els.btnLog.addEventListener('click', function () { setLog(!logOpen); });
    if (els.btnSettings) els.btnSettings.addEventListener('click', function () { setSettings(!settingsOpen); });
    if (els.btnSettingsClose) els.btnSettingsClose.addEventListener('click', function () { setSettings(false); });
    if (els.setBgm) els.setBgm.addEventListener('input', onBgmVolume);
    if (els.setSfx) els.setSfx.addEventListener('input', onSfxVolume);
    if (els.setAnim) els.setAnim.addEventListener('change', onAnimToggle);
    if (els.setPace) els.setPace.addEventListener('click', onPacePick);
    els.btnLogClose.addEventListener('click', function () { setLog(false); });
    els.btnQuit.addEventListener('click', function () { if (hooks.onQuit) hooks.onQuit(); });
    if (els.btnSurrender) els.btnSurrender.addEventListener('click', function () { if (hooks.onSurrender) hooks.onSurrender(); });
    if (els.btnTrust) els.btnTrust.addEventListener('click', function () { if (hooks.onTrust) hooks.onTrust(); });
    if (els.btnSave) els.btnSave.addEventListener('click', function () { if (hooks.onSave) hooks.onSave(); });
    if (els.btnContinue) els.btnContinue.addEventListener('click', function () { if (hooks.onContinue) hooks.onContinue(); });
    els.btnAgain.addEventListener('click', function () { if (hooks.onAgain) hooks.onAgain(); });
    els.btnHome.addEventListener('click', function () { if (hooks.onHome) hooks.onHome(); });

    document.addEventListener('mouseover', function (e) {
      const t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!t) return;
      // 选牌/选目标时，座位上的武将介绍不得弹出
      const seat = t.closest && t.closest('.seat');
      if (seat && (sel.action || tablePick) && !t.closest('.eq-bar')) { hideTip(); return; }
      showTip(t.getAttribute('data-tip'), t);
    });
    // 手机触摸没有 mouseout：点击/触摸任何非 data-tip 区域关闭浮层
    document.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest('[data-tip]')) return;
      hideTip();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') hideTip();
    });
    document.addEventListener('mouseout', function (e) {
      const t = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!t) return;
      const to = e.relatedTarget;
      if (to && t.contains(to)) return;
      hideTip();
    });
    document.addEventListener('click', function (e) {
      if (!chooser) return;
      if (e.target.closest && (e.target.closest('.card-chooser') || e.target.closest('.hand-card'))) return;
      closeChooser();
    }, true);
    window.addEventListener('resize', function () {
      // 横竖屏切换时座位坐标/尺寸需要重算；重建座位后保持原事件绑定
      seatGame = null;
      if (game && screen === 'game') {
        try { render(game); } catch (e) { /* ignore */ }
      }
      scheduleLayout();
      drawAim();
      hideTip();
    });
    if (typeof ResizeObserver !== 'undefined' && els.hand && els.hand.parentElement) {
      try { new ResizeObserver(function () { scheduleLayout(); }).observe(els.hand.parentElement); } catch (e) { /* ignore */ }
    }
    document.addEventListener('keydown', onKeyDown);
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (generalInfoOpen) { closeGeneralInfo(); return; }
      if (settingsOpen) { setSettings(false); return; }
      if (chooser) { closeChooser(); return; }
      const req = pending && pending.req;
      if (req && req.type === 'play' && sel.action) { cancelPlay(); return; }
      if (req && req.type === 'response') { resolveAnswer(null); return; }
      if (req && ['chooseCards', 'chooseTargets', 'chooseCardFrom', 'chooseHiddenCard', 'arrange', 'pickFrom', 'distribute'].includes(req.type)) {
        const min = req.min || 0;
        if (min === 0) resolveAnswer(defaultEmpty(req));
      }
      return;
    }
    if (e.key === 'Enter') {
      const req = pending && pending.req;
      if (!req) return;
      if (req.type === 'play') { if (playReady()) submitPlay(); }
      else if (req.type === 'response') { if (respSel) submitResponse(); }
      else if (req.type === 'chooseGeneral') { if (selectIdx >= 0) onGeneralConfirm(); }
      else if (req.type === 'chooseCards' && handPickMode(req)) {
        if (!confirmHandPick()) toast('请按要求选择手牌', true);
      }
      else if (['chooseCards', 'chooseTargets', 'chooseCardFrom', 'chooseHiddenCard', 'arrange', 'pickFrom', 'distribute'].includes(req.type)) {
        modalConfirm();
      }
    }
  }

  function defaultEmpty(req) {
    if (req.type === 'chooseCards' || req.type === 'chooseTargets') return [];
    if (req.type === 'chooseCardFrom') return null;
    return null;
  }

  /* ============================================================
     屏幕 / 游戏绑定
     ============================================================ */
  function showScreen(name) {
    screen = name;
    const map = { menu: els.screenMenu, select: els.screenSelect, game: els.screenGame, result: els.screenResult };
    Object.keys(map).forEach(function (k) {
      const el = map[k];
      if (el) el.classList.toggle('is-active', k === name);
    });
    if (name !== 'game') {
      closeChooser(); setLog(false); setSettings(false);
      if (els.aim) els.aim.innerHTML = '';
      if (els.skillBanner) els.skillBanner.classList.remove('is-on');
      clearJudgeOverlay();
      clearFlowFx();
      closeGeneralInfo();
    }
    if (name === 'game') { handDirty = false; scheduleLayout(); }
  }

  function bindGame(g) {
    game = g;
    last.damageMuteUntil = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 1500;
    humanSeat = g && g.humanSeat != null ? g.humanSeat : 0;
    if (els.screenGame) els.screenGame.classList.toggle('mode-1v1', !!(g && g.mode === '1v1'));
    lastPhaseShown = null;
    hoverSeat = null;
    heldBarHTML = ''; holdUntil = 0;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = 0; }
    if (skillBannerTimer) { clearTimeout(skillBannerTimer); skillBannerTimer = 0; }
    if (els.skillBanner) { els.skillBanner.classList.remove('is-on'); els.skillBanner.innerHTML = ''; }
    if (els.aim) els.aim.innerHTML = '';
    pending = null;
    tablePick = null;
    if (els.pickBar) els.pickBar.innerHTML = '';
    sel.action = null; sel.cards = []; sel.targets = [];
    respSel = null; respCardId = null;
    chooser = null;
    modalReq = null; m = null;
    pickState = null;
    fatalError = null; lastFatalHTML = '';
    resultFor = null;
    clearCountdown();
    seatMarks = {};
    effectsGame = null;
    seatGame = null;
    seatEls.clear();
    if (els.seats) els.seats.innerHTML = '';
    if (els.modalRoot) els.modalRoot.innerHTML = '';
    if (els.hand) els.hand.innerHTML = '';
    if (els.played) { els.played.innerHTML = ''; els.played.classList.remove('is-cover'); }
    if (els.fx) els.fx.innerHTML = '';
    last.handSig = ''; last.skillSig = ''; last.equipSig = ''; last.judgeSig = '__init__';
    last.logLen = -1; last.logTail = null; last.recentLen = 0;
    last.sfxLogLen = 0; last.sfxLogTail = null;
    last.judgeLogLen = 0; last.judgeLogTail = null;
    last.flowLogLen = 0; last.flowLogTail = null;
    lastTrick = null;
    cancelSeatPress();
    closeGeneralInfo();
    clearJudgeOverlay();
    clearFlowFx();
    last.tableSig = ''; last.hp = {}; last.actionHTML = ''; last.modalHTML = '';
    meArtKey = ''; handDirty = false;
    if (els.logBody) els.logBody.innerHTML = '';
    try {
      if (new URLSearchParams(global.location.search).get('log') === '1') setLog(true);
    } catch (e) { /* ignore */ }
    showScreen('game');
    render(g);
  }

  function request(req, resolve) {
    pending = { req: req, resolve: resolve };
    sel.action = null; sel.cards = []; sel.targets = [];
    respSel = null; respCardId = null; chooser = null;
    modalReq = null; m = null;
    last.actionHTML = ''; last.modalHTML = '';
    tablePick = (req.type === 'chooseTargets') ? { req: req, selected: [] } : null;
    if (req.type === 'chooseGeneral') {
      selectIdx = -1;
      selectSig = '';
      showScreen('select');
      renderSelect(game);
    } else {
      if (screen !== 'game') showScreen('game');
      render(game);
    }
    startCountdown(req);
  }

  function pauseCountdown() {
    if (!countdownReq || countdownPaused) return;
    countdownRemainMs = Math.max(0, countdownEnd - Date.now());
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = 0; }
    countdownPaused = true;
  }
  function resumeCountdown() {
    if (!countdownPaused || !countdownReq) return;
    countdownPaused = false;
    countdownEnd = Date.now() + countdownRemainMs;
    runCountdown(countdownReq);
  }

  function clearCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = 0; }
    countdownEnd = 0;
    countdownReq = null;
    countdownPaused = false;
    countdownRemainMs = 0;
    if (els.tbCount) {
      els.tbCount.textContent = '';
      els.tbCount.classList.remove('is-warn');
    }
    if (els.handTimer) {
      els.handTimer.textContent = '';
      els.handTimer.classList.remove('is-on', 'is-warn');
    }
    if (els.orbitTimer) {
      els.orbitTimer.textContent = '';
      els.orbitTimer.classList.remove('is-on', 'is-warn');
    }
  }

  function setCountdownDisplay(left) {
    const warn = left <= 10;
    const label = '剩余 ' + left + 's';
    if (els.tbCount) {
      els.tbCount.textContent = label;
      els.tbCount.classList.toggle('is-warn', warn);
      els.tbCount.title = warn ? '剩余时间不足 10 秒，超时由 AI 代操作' : '剩余操作时间，超时由 AI 代操作';
    }
    if (els.handTimer) {
      els.handTimer.textContent = '⏱ ' + label;
      els.handTimer.classList.add('is-on');
      els.handTimer.classList.toggle('is-warn', warn);
    }
    if (els.orbitTimer) {
      els.orbitTimer.textContent = label;
      els.orbitTimer.classList.add('is-on');
      els.orbitTimer.classList.toggle('is-warn', warn);
    }
  }

  function defaultAnswer(req) {
    if (!req) return null;
    switch (req.type) {
      case 'play': return { kind: 'end' };
      case 'response': return null;
      case 'chooseCards': return (req.cards || []).slice(0, req.min || 0).map(function (c) { return c.id; });
      case 'chooseTargets': return (req.candidates || []).slice(0, req.min || 0);
      case 'chooseOption': {
        const list = req.options || [];
        const no = list.find(function (o) { return o.id === 'no' || o.id === 'cancel'; });
        return no ? no.id : (list[0] ? list[0].id : null);
      }
      case 'chooseCardFrom': return null;
      case 'arrange': return { top: (req.cards || []).slice(), bottom: [] };
      case 'pickFrom': return req.cards && req.cards[0] ? req.cards[0].id : null;
      case 'distribute': return (req.cards || []).map(function (c) { return { cardId: c.id, seat: humanSeat }; });
      case 'chooseGeneral': return { index: 0 };
      default: return null;
    }
  }

  function autoActForHuman(req) {
    if (!req) return;
    let ai = null;
    try {
      if (global.SGS && global.SGS.AI && game) {
        ai = new global.SGS.AI(game, humanSeat, { speed: 0, aiLevel: 'normal' });
      }
    } catch (e) { ai = null; }
    const fallback = function () {
      if (!pending || pending.req !== req) return;
      resolveAnswer(defaultAnswer(req));
    };
    if (!ai) { fallback(); return; }
    Promise.resolve(ai.decide(req)).then(function (ans) {
      if (!pending || pending.req !== req) return;
      resolveAnswer(ans == null ? defaultAnswer(req) : ans);
    }).catch(function () {
      fallback();
    });
  }

  function tickCountdown(req) {
    if (countdownPaused || !req) return;
    const left = Math.max(0, Math.ceil((countdownEnd - Date.now()) / 1000));
    setCountdownDisplay(left);
    if (left <= 0) {
      if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = 0; }
      if (pending && pending.req === req) {
        toast('操作超时，AI 已代你行动');
        autoActForHuman(req);
      }
    }
  }
  function runCountdown(req) {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = 0; }
    tickCountdown(req);
    countdownTimer = setInterval(function () { tickCountdown(req); }, 500);
  }
  function startCountdown(req) {
    clearCountdown();
    // 选将页不显示读秒；人类出牌/响应是 UI 读秒（引擎没有超时机制，仅展示）
    if (!req || req.type === 'chooseGeneral') return;
    const secs = req.type === 'play' ? 90 : (req.type === 'response' ? 45 : 60);
    countdownReq = req;
    countdownPaused = false;
    countdownRemainMs = secs * 1000;
    countdownEnd = Date.now() + countdownRemainMs;
    runCountdown(req);
  }

  function freeze(req) {
    tablePick = null;
    pending = { req: req, resolve: function () {} };
    sel.action = null; sel.cards = []; sel.targets = [];
    respSel = null; respCardId = null; chooser = null;
    modalReq = null; m = null;
    last.actionHTML = ''; last.modalHTML = '';
    if (req.type === 'chooseGeneral') {
      selectIdx = -1; selectSig = '';
      showScreen('select');
      renderSelect(game);
    } else {
      showScreen('game');
      render(game);
    }
  }

  function resolveAnswer(ans) {
    clearCountdown();
    lastAnswer = ans;
    const p = pending;
    if (screen === 'game' && p && p.req && (p.req.type === 'play' || p.req.type === 'response') && els.actionBar) {
      heldBarHTML = els.actionBar.innerHTML;
      holdUntil = Date.now() + 650;
    }
    pending = null;
    tablePick = null;
    if (els.pickBar) els.pickBar.innerHTML = '';
    sel.action = null; sel.cards = []; sel.targets = [];
    respSel = null; respCardId = null; chooser = null;
    modalReq = null; m = null;
    pickState = null;
    hideChooser();
    if (p && typeof p.resolve === 'function') {
      try { p.resolve(ans); } catch (e) { console.error(e); }
    }
    if (screen === 'select') showScreen('game');
    if (game) render(game);
  }

  function showError(err) {
    fatalError = err || new Error('未知错误');
    console.error('[SGS-UI]', err);
    if (!els.modalRoot) return;
    renderFatal();
    if (err && err.message) toast('运行错误：' + err.message, true);
  }

  /* ============================================================
     主渲染
     ============================================================ */
  function render(g) {
    if (!g) return;
    game = g;
    if (fatalError) { renderFatal(); return; }
    if (g.over) { showResult(g); return; }
    if (screen === 'select') { renderSelect(g); return; }
    if (screen !== 'game') return;

    renderTop(g);
    if (g.phase && g.phase !== 'init' && g.phase !== lastPhaseShown) {
      lastPhaseShown = g.phase;
      showPhaseBanner(g);
    }
    renderSeats(g);
    renderMe(g);
    renderHand(g);
    layoutHand();
    scheduleLayout();
    if (handLayoutTimer) clearTimeout(handLayoutTimer);
    handLayoutTimer = setTimeout(function () { handLayoutTimer = 0; layoutHand(); }, 90);
    renderActionBar(g);
    renderCenter(g);
    renderLog(g);
    renderModal(g);
    renderPickBar();
    detectEffects(g);
  }

  /* ---------- 阶段横幅 ---------- */
  function showPhaseBanner(g) {
    if (!els.phaseBanner || !g) return;
    const name = PHASE_CN[g.phase];
    if (!name) return;
    const cur = g.players && g.players[g.currentSeat];
    els.phaseBannerTitle.textContent = name;
    els.phaseBannerSub.textContent = cur ? (cur.isHuman ? '你的回合' : displayName(cur)) : '';
    els.phaseBanner.classList.remove('is-on');
    if (els.phaseOrbit) els.phaseOrbit.classList.add('is-suppressed');
    void els.phaseBanner.offsetWidth;
    els.phaseBanner.classList.add('is-on');
    if (phaseTimer) clearTimeout(phaseTimer);
    phaseTimer = setTimeout(function () {
      if (els.phaseBanner) els.phaseBanner.classList.remove('is-on');
      if (els.phaseOrbit) els.phaseOrbit.classList.remove('is-suppressed');
    }, 780);
  }

  function cardInfoOfText(text) {
    const m = /【(.+?)】([♠♥♣♦])(A|10|[2-9]|J|Q|K)/.exec(String(text || ''));
    if (!m) return null;
    const name = m[1], suit = m[2], rank = m[3];
    const key = Object.keys(CARDS).find(function (k) { return CARDS[k].name === name; });
    return {
      name: name, suit: suit, rank: rank,
      color: (suit === '♥' || suit === '♦') ? 'red' : 'black',
      label: '【' + name + '】' + suit + rank,
      img: key && !CARDS[key].noArt ? ('assets/cards/' + CARDS[key].pinyin + '.png') : '',
    };
  }

  function cardInfoByName(name) {
    const key = Object.keys(CARDS).find(function (k) { return CARDS[k].name === name; });
    if (!key) return null;
    return { name: name, suit: '', rank: '', color: '', label: '【' + name + '】', img: (!CARDS[key] || CARDS[key].noArt) ? '' : ('assets/cards/' + CARDS[key].pinyin + '.png') };
  }

  function flowSeatOf(name) {
    if (!game || !name) return null;
    const n = String(name).trim();
    for (const p of (game.players || [])) {
      const gen = p.general;
      const names = [];
      if (p.isHuman) { names.push('你'); if (gen) names.push('你（' + gen.name + '）'); }
      if (gen) names.push(gen.name);
      if (p.name) names.push(p.name);
      if (names.indexOf(n) >= 0) return p.seat;
    }
    return null;
  }

  function flowPoint(seat) {
    if (!els.flowLayer) return null;
    let el = null;
    if (seat == null) {
      el = q('table-center');
    } else if (seat === humanSeat) {
      el = els.mePortrait;
    } else {
      const root = seatEls.get(seat);
      el = root || null;
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const lr = els.flowLayer.getBoundingClientRect();
    if (!r.width && !r.height) return { x: lr.width / 2, y: lr.height / 2 };
    return { x: r.left - lr.left + r.width / 2, y: r.top - lr.top + r.height * 0.45 };
  }

  function wuguSourcePoint() {
    if (!els.flowLayer) return null;
    const el = els.wuguCards || els.wuguTray;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const lr = els.flowLayer.getBoundingClientRect();
    return { x: r.left - lr.left + r.width / 2, y: r.top - lr.top + r.height / 2 };
  }

  function setWuguPicker(seat) {
    seatEls.forEach(function (root, s) {
      root.classList.toggle('is-wugu-picker', s === seat);
    });
    if (els.mePortrait) els.mePortrait.classList.toggle('is-wugu-picker', seat === humanSeat);
  }

  function flowFloatAt(seat, text, cls, lift) {
    if (!els.flowLayer || seat == null) return;
    let pt = flowPoint(seat);
    if (!pt) return;
    let humanFloat = false;
    // 手机/窄屏：浮字放到头像右侧/座位上方，不遮脸
    const lr = els.flowLayer.getBoundingClientRect();
    if (global.innerWidth <= 1100) {
      if (seat === humanSeat && els.mePortrait) {
        const pr = els.mePortrait.getBoundingClientRect();
        pt = { x: pr.right - lr.left + 26, y: pr.top - lr.top + 20 };
        humanFloat = true;
      } else {
        const el = seatEls.get(seat);
        if (el) {
          const r = el.getBoundingClientRect();
          pt = { x: r.left - lr.left + r.width / 2, y: r.top - lr.top - 8 };
        }
      }
    }
    const node = document.createElement('div');
    node.className = 'flow-float ' + (cls || '') + (humanFloat ? ' is-human' : '');
    node.textContent = text;
    node.style.left = pt.x + 'px';
    node.style.top = (pt.y - (lift ? 24 : 10)) + 'px';
    els.flowLayer.appendChild(node);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 1250);
  }

  function queueFlow(ev) {
    if (!ev || (ev.from == null && ev.to == null)) return;
    flowQueue.push(ev);
    if (!flowPumpTimer) pumpFlow();
  }

  function pumpFlow() {
    if (!flowQueue.length) { flowPumpTimer = 0; return; }
    const ev = flowQueue.shift();
    animateFlow(ev);
    flowPumpTimer = setTimeout(function () {
      flowPumpTimer = 0;
      pumpFlow();
    }, ev.kind === 'gain' ? 640 : 280);
  }

  function animateFlow(ev) {
    if (!els.flowLayer) return;
    const wuguSource = (ev.from == null && ev.kind === 'gain' && wuguState) ? wuguSourcePoint() : null;
    if (wuguState && ev.kind === 'gain' && ev.cardLabel) removeWuguCard(ev.cardLabel, ev.to);
    const a = wuguSource || flowPoint(ev.from);
    const b = flowPoint(ev.to);
    if (!a || !b) return;
    if (wuguSource) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const trail = document.createElement('div');
      trail.className = 'flow-trail';
      trail.style.left = a.x + 'px';
      trail.style.top = a.y + 'px';
      trail.style.width = dist + 'px';
      trail.style.transform = 'rotate(' + (Math.atan2(dy, dx) * 180 / Math.PI) + 'deg)';
      els.flowLayer.appendChild(trail);
      setTimeout(function () { if (trail.parentNode) trail.parentNode.removeChild(trail); }, 720);
    }
    const n = Math.max(1, Math.min(ev.count || 1, 3));
    for (let i = 0; i < n; i++) {
      const card = document.createElement('div');
      card.className = 'flow-card' + (wuguSource ? ' is-wugu' : '');
      card.style.left = a.x + 'px';
      card.style.top = a.y + 'px';
      card.style.setProperty('--dx', (b.x - a.x) + 'px');
      card.style.setProperty('--dy', (b.y - a.y) + 'px');
      card.style.setProperty('--rot', ((i % 2 ? 1 : -1) * (3 + i * 2)) + 'deg');
      card.style.transitionDelay = (i * 55) + 'ms';
      els.flowLayer.appendChild(card);
      requestAnimationFrame(function () { card.classList.add('is-fly'); });
      setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 700 + i * 55);
    }
    if (ev.to != null) {
      let label = '';
      if (ev.kind === 'draw') label = '+' + (ev.count || 1) + ' 牌';
      else if (ev.kind === 'discard') label = '-' + (ev.count || 1) + ' 牌';
      else if (ev.kind === 'equip') label = '装备 ' + (ev.cardLabel || '');
      else if (ev.kind === 'swap') label = '交换手牌';
      else if (ev.cardLabel) label = '获得 ' + ev.cardLabel;
      else label = '+' + (ev.count || 1) + ' 牌' + (ev.label ? ' · ' + ev.label : '');
      flowFloatAt(ev.to, label, ev.kind === 'draw' ? 'is-draw' : (ev.kind === 'discard' ? 'is-discard' : (ev.kind === 'gain' ? 'is-gain' : 'is-give')), !!wuguSource);
    } else if (ev.from != null) {
      flowFloatAt(ev.from, '-' + (ev.count || 1) + ' 牌', 'is-discard');
    }
  }

  function parseFlowLog(text) {
    const t = String(text || '').trim();
    const out = [];
    let m;
    // 摸牌
    m = /^(.+?) 摸了 (\d+) 张牌(?:（(.+?)）)?$/.exec(t);
    if (m) { const seat = flowSeatOf(m[1]); if (seat != null) out.push({ from: null, to: seat, count: +m[2], label: m[3] || '摸牌', kind: 'draw' }); return out; }
    // 仁德/交给
    m = /^(.+?) 发动【(.+?)】交给 (.+?) (\d+) 张牌$/.exec(t);
    if (m) { const a = flowSeatOf(m[1]), b = flowSeatOf(m[3]); if (a != null && b != null) out.push({ from: a, to: b, count: +m[4], label: m[2], kind: 'give' }); return out; }
    m = /^(.+?) 将 (\d+) 张牌交给 (.+?)$/.exec(t);
    if (m) { const a = flowSeatOf(m[1]), b = flowSeatOf(m[3]); if (a != null && b != null) out.push({ from: a, to: b, count: +m[2], label: '交给', kind: 'give' }); return out; }
    m = /^(.+?) 发动【黄天】交给主公 (.+)$/.exec(t);
    if (m) { const a = flowSeatOf(m[1]); const lord = game && game.lord; if (a != null && lord) out.push({ from: a, to: lord.seat, count: 1, label: '黄天', kind: 'give' }); return out; }
    // 从某角色获得一张
    m = /^(.+?) (?:发动【(.+?)】)?获得 (.+?) 一张(?:手)?牌$/.exec(t);
    if (m) { const a = flowSeatOf(m[1]), b = flowSeatOf(m[3]); if (a != null && b != null) out.push({ from: b, to: a, count: 1, label: m[2] || '获得', kind: 'gain' }); return out; }
    // 获得 N 张牌
    m = /^(.+?) (?:发动【(.+?)】)?获得 (\d+) 张牌$/.exec(t);
    if (m) { const a = flowSeatOf(m[1]); if (a != null) out.push({ from: null, to: a, count: +m[3], label: m[2] || '获得', kind: 'gain' }); return out; }
    // 获得具体牌（可能多张）
    m = /^(.+?) (?:发动【(.+?)】)?获得 (【.+)$/.exec(t);
    if (m) {
      const a = flowSeatOf(m[1]);
      const ci = cardInfoOfText(m[3]);
      if (a != null && ci) out.push({ from: null, to: a, count: Math.max(1, (m[3].match(/【/g) || []).length), label: m[2] || '获得', kind: 'gain', cardLabel: ci.label });
      return out;
    }
    // 弃置某角色一张
    m = /^(.+?) 弃置 (.+?) 一张(?:手)?牌$/.exec(t);
    if (m) { const a = flowSeatOf(m[2]); if (a != null) out.push({ from: a, to: null, count: 1, label: '弃置', kind: 'discard' }); return out; }
    // 弃置 N 张
    m = /^(.+?) 弃置了 (\d+) 张牌$/.exec(t);
    if (m) { const a = flowSeatOf(m[1]); if (a != null) out.push({ from: a, to: null, count: +m[2], label: '弃置', kind: 'discard' }); return out; }
    m = /^(.+?) 因【(.+?)】弃置 (\d+) 张牌$/.exec(t);
    if (m) { const a = flowSeatOf(m[1]); if (a != null) out.push({ from: a, to: null, count: +m[3], label: m[2], kind: 'discard' }); return out; }
    // 制衡：弃牌（摸牌另有日志）
    m = /^(.+?) 发动【制衡】弃 (\d+) 张摸 (\d+) 张$/.exec(t);
    if (m) { const a = flowSeatOf(m[1]); if (a != null) out.push({ from: a, to: null, count: +m[2], label: '制衡', kind: 'discard' }); return out; }
    // 反间
    m = /^(.+?) 对 (.+?) 发动【反间】/.exec(t);
    if (m) { const a = flowSeatOf(m[1]), b = flowSeatOf(m[2]); if (a != null && b != null) out.push({ from: a, to: b, count: 1, label: '反间', kind: 'give' }); return out; }
    // 缔盟
    m = /^(.+?) 发动【缔盟】交换 (.+?) 与 (.+?) 的手牌$/.exec(t);
    if (m) { const a = flowSeatOf(m[2]), b = flowSeatOf(m[3]); if (a != null && b != null) { out.push({ from: a, to: b, count: 1, label: '缔盟', kind: 'swap' }); out.push({ from: b, to: a, count: 1, label: '缔盟', kind: 'swap' }); } return out; }
    // 装备
    m = /^(.+?) 装备 (【.+)$/.exec(t);
    if (m) { const a = flowSeatOf(m[1]); const ci = cardInfoOfText(m[2]); if (a != null) out.push({ from: null, to: a, count: 1, label: '装备', kind: 'equip', cardLabel: ci ? ci.label : '' }); return out; }
    // 替换弃置
    m = /^(.+?) 的 (【.+?) 被替换弃置$/.exec(t);
    if (m) { const a = flowSeatOf(m[1]); if (a != null) out.push({ from: a, to: null, count: 1, label: '替换', kind: 'discard' }); return out; }
    // 巧变移动
    m = /^(.+?) 发动【巧变】将 (.+?) 的 .+ 移到 (.+?) 的/.exec(t);
    if (m) { const a = flowSeatOf(m[2]), b = flowSeatOf(m[3]); if (a != null && b != null) out.push({ from: a, to: b, count: 1, label: '巧变', kind: 'give' }); return out; }
    // 铁索重铸
    m = /^(.+?) 重铸【铁索连环】摸一张牌$/.exec(t);
    if (m) { const a = flowSeatOf(m[1]); if (a != null) out.push({ from: null, to: a, count: 1, label: '重铸', kind: 'draw' }); return out; }
    return out;
  }

  function renderWuguList(list) {
    if (!list || !list.length) return;
    wuguState = { cards: list, total: list.length };
    if (els.wuguCards) {
      els.wuguCards.innerHTML = list.map(function (c, i) {
        return '<div class="wugu-card" data-i="' + i + '" data-label="' + esc(c.label) + '">' +
          (c.img ? '<img src="' + c.img + '" alt="">' : '') +
          '<span class="wc-suit" style="color:' + (c.color === 'red' ? '#ff8270' : '#e9e1cf') + '">' + c.suit + '</span>' +
          '<span class="wc-rank">' + c.rank + '</span>' +
          '<span class="wc-name">' + esc(c.name) + '</span></div>';
      }).join('');
    }
    if (els.wuguCount) els.wuguCount.textContent = list.length + ' 张待选';
    if (els.wuguLast) els.wuguLast.textContent = '';
    if (els.wuguTray) els.wuguTray.classList.add('is-on');
    if (wuguTimer) clearTimeout(wuguTimer);
    // 无懈/逐人选牌可能持续超过 15 秒，不能无条件关闭
    wuguTimer = setTimeout(function () { wuguTimer = 0; clearWugu(); }, 60000);
  }
  function showWuguReveal(text) {
    const raw = String(text || '').split('：').slice(1).join('：');
    const list = raw.split('、').map(function (x) { return cardInfoOfText(x); }).filter(Boolean);
    if (list.length) renderWuguList(list);
  }
  function showWuguFromCards(cards) {
    const list = (cards || []).map(function (c) {
      const def = cardDef(c.name);
      return {
        name: c.name, suit: c.suit || '', rank: c.rank == null ? '' : c.rank,
        color: (c.color === 'red' || c.suit === '♥' || c.suit === '♦') ? 'red' : 'black',
        label: '【' + c.name + '】' + (c.suit || '') + (c.rank == null ? '' : c.rank),
        img: def && !def.noArt ? ('assets/cards/' + def.pinyin + '.png') : '',
      };
    }).filter(function (c) { return c.name; });
    if (list.length) renderWuguList(list);
  }

  function removeWuguCard(label, toSeat) {
    if (!wuguState) return;
    const idx = wuguState.cards.findIndex(function (c) { return c.label === label; });
    if (idx < 0) return;
    wuguState.cards.splice(idx, 1);
    const p = toSeat != null && game ? game.players[toSeat] : null;
    if (els.wuguLast) els.wuguLast.textContent = (p ? displayName(p) : '角色') + ' 获得 ' + label;
    if (els.wuguCards) {
      const node = Array.prototype.find.call(els.wuguCards.children, function (n) { return n.getAttribute('data-label') === label; });
      if (node) { node.classList.add('is-gone'); setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 340); }
    }
    if (els.wuguCount) els.wuguCount.textContent = wuguState.cards.length + ' 张待选';
    if (!wuguState.cards.length) {
      if (wuguTimer) clearTimeout(wuguTimer);
      wuguTimer = setTimeout(function () { wuguTimer = 0; clearWugu(); }, 800);
    }
  }

  function clearWugu() {
    if (wuguTimer) { clearTimeout(wuguTimer); wuguTimer = 0; }
    wuguState = null;
    setWuguPicker(null);
    if (els.wuguTray) els.wuguTray.classList.remove('is-on');
    if (els.wuguCards) els.wuguCards.innerHTML = '';
    if (els.wuguLast) els.wuguLast.textContent = '';
    if (els.wuguPicker) els.wuguPicker.textContent = '';
  }

  function queueReveal(info) {
    if (!info) return;
    revealQueue.push(info);
    if (!revealShowing) showNextReveal();
  }

  function showNextReveal() {
    if (!els.revealBox) return;
    if (!revealQueue.length) {
      revealShowing = false;
      els.revealBox.classList.remove('is-on');
      if (els.played) els.played.classList.remove('is-cover');
      const sg0 = q('screen-game');
      if (sg0) sg0.classList.remove('is-revealing');
      return;
    }
    revealShowing = true;
    if (els.played) els.played.classList.add('is-cover');
    const sg = q('screen-game');
    if (sg) sg.classList.add('is-revealing');
    const info = revealQueue.shift();
    const card = info.card;
    if (els.revealTitle) els.revealTitle.textContent = info.title || '亮牌';
    if (els.revealSub) els.revealSub.textContent = info.sub || '';
    if (els.revealSuit) {
      els.revealSuit.textContent = card.suit || '';
      els.revealSuit.style.color = card.color === 'red' ? '#ff8270' : '#e9e1cf';
    }
    if (els.revealRank) els.revealRank.textContent = card.rank || '';
    if (els.revealName) els.revealName.textContent = card.name || '';
    if (els.revealImg) {
      if (card.img) {
        els.revealImg.style.display = '';
        els.revealImg.onerror = function () { this.onerror = null; this.style.display = 'none'; };
        els.revealImg.src = card.img;
      } else {
        els.revealImg.removeAttribute('src');
        els.revealImg.style.display = 'none';
      }
    }
    els.revealBox.classList.remove('is-on');
    void els.revealBox.offsetWidth;
    els.revealBox.classList.add('is-on');
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = setTimeout(function () {
      revealTimer = 0;
      if (els.revealBox) els.revealBox.classList.remove('is-on');
      setTimeout(function () {
        if (revealShowing) { revealShowing = false; showNextReveal(); }
      }, 160);
    }, 950);
  }

  function handleRevealLog(lg) {
    const text = String(lg && lg.text || '');
    if (lg && lg.type === 'respond') {
      const m = /^(.+?) 打出 (.+)$/.exec(text);
      if (m) {
        const card = cardInfoOfText(m[2]);
        if (card) queueReveal({ title: '响应', sub: m[1] + ' 打出 ' + card.label, card: card });
      }
      return;
    }
    if (lg && lg.type === 'wuxie') {
      const m = /^(.+?) 使用【无懈可击】(抵消|反抵消)了 (.+)$/.exec(text);
      if (m) {
        const raw = m[3];
        const tm = /（目标：(.+?)）$/.exec(raw);
        const targetName = tm ? tm[1] : '';
        const cardText = raw.replace(/（目标：.+?）$/, '');
        const victim = cardInfoOfText(cardText);
        const usedWuxie = (game && game.discardPile ? game.discardPile : []).filter(function (c) { return c && c.name === 'wuxie'; });
        const wc = usedWuxie.length ? usedWuxie[usedWuxie.length - 1] : null;
        const ws = wc ? suitOf(wc) : null;
        const card = wc && ws
          ? { name: '无懈可击', suit: ws.cn, rank: rankCn(wc.rank), color: ws.color, img: 'assets/cards/wuxie.png' }
          : (cardInfoByName('无懈可击') || { name: '无懈可击', suit: '', rank: '', color: '', img: '' });
        const arrow = targetName ? (m[1] + ' → ' + targetName + '：') : (m[1] + '：');
        const caster = game && game.players ? game.players.find(function (p) {
          return p && (p.name === m[1] || (p.general && p.general.name === m[1]));
        }) : null;
        // 无懈音频以战报为准：自用/对人用都走这里，避免 recent 路径漏播
        try { sfx('playCard', 'wuxie', caster ? caster.gender : undefined); } catch (e) { /* ignore */ }
        queueReveal({
          title: '无懈可击',
          sub: arrow + m[2] + ' ' + (victim ? victim.label : cardText),
          card: card,
        });
        const sourceSeat = flowSeatOf(m[1]);
        let targetSeat = targetName ? flowSeatOf(targetName) : null;
        if (targetSeat == null && lastTrick && (lastTrick.targets || []).length === 1) {
          targetSeat = lastTrick.targets[0];
        }
        if (sourceSeat != null) markWuxieSeat(sourceSeat, 'seat-wuxie-src');
        if (targetSeat != null) {
          markWuxieSeat(targetSeat, 'seat-wuxie-tgt');
          flashSeat(targetSeat);
          flowFloatAt(targetSeat, '被无懈', 'is-discard');
        }
        if (sourceSeat != null && targetSeat != null && sourceSeat !== targetSeat) {
          const now = Date.now();
          transientAim = transientAim.filter(function (a) { return a.until > now; });
          transientAim.push({ from: sourceSeat, to: targetSeat, until: now + 1200 });
          drawAim();
          if (flashAimTimer) clearTimeout(flashAimTimer);
          flashAimTimer = setTimeout(function () { flashAimTimer = 0; drawAim(); }, 1250);
        }
      }
    }
  }

  function clearFlowFx() {
    if (flowPumpTimer) { clearTimeout(flowPumpTimer); flowPumpTimer = 0; }
    flowQueue = [];
    if (els.flowLayer) els.flowLayer.innerHTML = '';
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = 0; }
    revealQueue = [];
    revealShowing = false;
    if (els.revealBox) els.revealBox.classList.remove('is-on');
    clearWugu();
  }

  function updateWuguPicker(g) {
    if (!els.wuguTray) return;
    const pr = g.pendingRequest;
    if (!wuguState) {
      if (pr && pr.type === 'pickFrom' && /五谷/.test(pr.reason || '') && pr.cards && pr.cards.length) {
        showWuguFromCards(pr.cards);
      } else {
        setWuguPicker(null); if (els.wuguPicker) els.wuguPicker.textContent = ''; return;
      }
    }
    if (pr && pr.type === 'pickFrom' && /五谷/.test(pr.reason || '') && pr.player) {
      if (wuguTimer) { clearTimeout(wuguTimer); wuguTimer = 0; }
      els.wuguTray.classList.add('is-picking');
      setWuguPicker(pr.player.seat);
      if (els.wuguPicker) els.wuguPicker.textContent = displayName(pr.player) + ' 选牌中…';
    } else {
      els.wuguTray.classList.remove('is-picking');
      setWuguPicker(null);
      if (els.wuguPicker) els.wuguPicker.textContent = '';
    }
  }

  function showRescue(ev) {
    const ov = q('rescue-banner');
    if (!ov) return;
    const p = game && game.players ? game.players[ev.seat] : null;
    const d = game && game.players ? game.players[ev.dyingSeat] : null;
    const nm = q('rescue-name'), tx = q('rescue-text');
    if (nm) nm.textContent = p ? displayName(p) : '角色';
    if (tx) tx.textContent = ev.phase === 'ask' ? ' 正在决定是否救援 ' + (d ? displayName(d) : '濒死角色')
      : ev.phase === 'save' ? ' 使用【桃】救援' : ' 没有救援';
    ov.classList.remove('is-on', 'is-pass', 'is-save');
    if (ev.phase === 'pass') ov.classList.add('is-pass');
    if (ev.phase === 'save') ov.classList.add('is-save');
    ov.classList.add('is-on');
    if (pindianTimer) { /* 避免与拼点计时器混淆，独立计时 */ }
    clearTimeout(showRescue._t);
    showRescue._t = setTimeout(function () { ov.classList.remove('is-on'); }, ev.phase === 'ask' ? 700 : 800);
  }

  function showHandReveal(ev) {
    if (!ev || !ev.card) return;
    const ov = q('hand-reveal');
    if (!ov) return;
    const c = ev.card;
    const def = cardDef(c.name);
    const img = q('hr-img');
    if (img) {
      img.onerror = function () { this.style.visibility = 'hidden'; };
      img.style.visibility = '';
      img.src = def && !def.noArt ? ('assets/cards/' + def.pinyin + '.png') : '';
    }
    if (q('hr-suit')) q('hr-suit').textContent = c.suit || '';
    if (q('hr-rank')) q('hr-rank').textContent = c.rank == null ? '' : rankCn(c.rank);
    if (q('hr-name')) q('hr-name').textContent = def ? def.name : (c.name || '');
    if (q('hr-caption')) q('hr-caption').textContent = ev.reason || '展示手牌';
    ov.classList.remove('is-on', 'is-reveal');
    void ov.offsetWidth;
    ov.classList.add('is-on');
    setTimeout(function () { if (ov.classList.contains('is-on')) ov.classList.add('is-reveal'); }, 30);
    setTimeout(function () { ov.classList.remove('is-on', 'is-reveal'); }, 1100);
  }

  function showPindian(ev) {
    if (!ev || !ev.a || !ev.b) return;
    const ov = q('pindian-overlay');
    if (!ov) return;
    const fill = function (side, data) {
      const c = data.card || {};
      const def = cardDef(c.name);
      const nm = q('pd-' + side + '-name'), img = q('pd-' + side + '-img');
      if (nm) nm.textContent = data.name || '';
      if (img) {
        img.onerror = function () { this.style.visibility = 'hidden'; };
        img.style.visibility = '';
        img.src = def && !def.noArt ? ('assets/cards/' + def.pinyin + '.png') : '';
      }
      if (q('pd-' + side + '-suit')) q('pd-' + side + '-suit').textContent = c.suit || '';
      if (q('pd-' + side + '-rank')) q('pd-' + side + '-rank').textContent = c.rank == null ? '' : rankCn(c.rank);
      if (q('pd-' + side + '-cname')) q('pd-' + side + '-cname').textContent = def ? def.name : (c.name || '');
    };
    fill('a', ev.a); fill('b', ev.b);
    const res = q('pd-result');
    if (res) {
      const reason = ev.reason || '拼点';
      res.className = 'pd-result ' + (ev.tie ? 'is-tie' : ev.win ? 'is-win' : 'is-lose');
      res.textContent = reason + ' · ' + (ev.tie ? '平局' : ev.win ? (ev.a.name + ' 胜利') : (ev.b.name + ' 胜利'));
    }
    if (pindianTimer) clearTimeout(pindianTimer);
    ov.classList.remove('is-reveal', 'is-result');
    ov.classList.add('is-on');
    try { sfx('card_flip'); } catch (e) { /* ignore */ }
    void ov.offsetWidth;
    ov.classList.add('is-reveal');
    setTimeout(function () { if (ov.classList.contains('is-on')) ov.classList.add('is-result'); }, 620);
    pindianTimer = setTimeout(function () { pindianTimer = 0; ov.classList.remove('is-on', 'is-reveal', 'is-result'); }, 1650);
  }

  function handleEffectLog(lg) {
    if (!lg) return;
    const text = String(lg.text || '');
    if (/（初始手牌）|（手气卡）|（地主底牌）/.test(text)) return;
    if (/^【五谷丰登】亮出：/.test(text)) showWuguReveal(text);
    if (lg.type === 'respond' || lg.type === 'wuxie') handleRevealLog(lg);
    const events = parseFlowLog(text);
    for (const ev of events) queueFlow(ev);
  }

  function parseJudgeLog(text) {
    const m = /^(.*?)\s*判定（(.+?)）：(.+)$/.exec(String(text || ''));
    if (!m) return null;
    const who = m[1].trim();
    const reasonRaw = m[2].trim();
    const reason = (CARDS[reasonRaw] && CARDS[reasonRaw].name) || reasonRaw;
    const cardText = m[3].trim();
    const cm = /【(.+?)】([♠♥♣♦])(A|10|[2-9]|J|Q|K)/.exec(cardText);
    if (!cm) return null;
    const name = cm[1];
    const suit = cm[2];
    const rank = cm[3];
    const key = Object.keys(CARDS).find(function (k) { return CARDS[k].name === name; });
    const color = (suit === '♥' || suit === '♦') ? 'red' : 'black';
    let result = (color === 'red' ? '红色' : '黑色') + ' · ' + suit + rank;
    if (reason.indexOf('八卦') >= 0 || reason.indexOf('八阵') >= 0) {
      result = color === 'red' ? '红色 · 判定成功，视为使用【闪】' : '黑色 · 判定失败';
    } else if (reason.indexOf('闪电') >= 0) {
      result = (suit === '♠' && ['2', '3', '4', '5', '6', '7', '8', '9'].indexOf(rank) >= 0)
        ? '黑桃 ' + rank + ' · 闪电命中' : '未命中 · 闪电移至下家';
    } else if (reason.indexOf('乐不思蜀') >= 0) {
      result = suit === '♥' ? '红桃 · 判定通过' : '非红桃 · 跳过出牌阶段';
    } else if (reason.indexOf('兵粮') >= 0) {
      result = suit === '♣' ? '梅花 · 判定通过' : '非梅花 · 跳过摸牌阶段';
    } else if (reason.indexOf('铁骑') >= 0) {
      result = color === 'red' ? '红色 · 铁骑生效，目标不能出闪' : '黑色 · 铁骑未生效';
    }
    return {
      who: who, reason: reason, name: name, suit: suit, rank: rank,
      color: color, result: result,
      img: key && !CARDS[key].noArt ? ('assets/cards/' + CARDS[key].pinyin + '.png') : '',
    };
  }

  function clearJudgeOverlay() {
    if (judgeTimer) { clearTimeout(judgeTimer); judgeTimer = 0; }
    judgeQueue = [];
    judgeShowing = false;
    if (els.judgeOverlay) els.judgeOverlay.classList.remove('is-on', 'is-red', 'is-black');
  }

  function queueJudge(info) {
    if (!info) return;
    const sig = [info.who || '', info.reason || '', info.name || '', info.suit || '', info.rank || ''].join('|');
    const now = Date.now();
    if (sig === last.judgeSig && now - (last.judgeAt || 0) < 1500) return;
    last.judgeSig = sig; last.judgeAt = now;
    if (/闪电/.test(info.reason || '')) {
      try { sfx('playCard', 'shandian'); } catch (e) { /* ignore */ }
    }
    judgeQueue.push(info);
    if (!judgeShowing) showNextJudge();
  }

  function showNextJudge() {
    if (!els.judgeOverlay) return;
    if (!judgeQueue.length) {
      judgeShowing = false;
      els.judgeOverlay.classList.remove('is-on');
      return;
    }
    judgeShowing = true;
    const info = judgeQueue.shift();
    if (els.judgeReason) els.judgeReason.textContent = info.reason || '判定';
    if (els.judgeWho) els.judgeWho.textContent = info.who ? (info.who + ' 的判定') : '';
    if (els.judgeResult) els.judgeResult.textContent = info.result || '';
    if (els.judgeSuit) {
      els.judgeSuit.textContent = info.suit || '';
      els.judgeSuit.style.color = info.color === 'red' ? '#ff8270' : '#e9e1cf';
    }
    if (els.judgeRank) els.judgeRank.textContent = info.rank || '';
    if (els.judgeName) els.judgeName.textContent = info.name || '';
    if (els.judgeImg) {
      if (info.img) {
        els.judgeImg.style.display = '';
        els.judgeImg.onerror = function () { this.onerror = null; this.style.display = 'none'; };
        els.judgeImg.src = info.img;
      } else {
        els.judgeImg.removeAttribute('src');
        els.judgeImg.style.display = 'none';
      }
    }
    els.judgeOverlay.classList.remove('is-on', 'is-red', 'is-black');
    els.judgeOverlay.classList.add(info.color === 'red' ? 'is-red' : 'is-black');
    void els.judgeOverlay.offsetWidth;
    els.judgeOverlay.classList.add('is-on');

    if (judgeTimer) clearTimeout(judgeTimer);
    judgeTimer = setTimeout(function () {
      judgeTimer = 0;
      if (els.judgeOverlay) els.judgeOverlay.classList.remove('is-on');
      setTimeout(function () {
        if (judgeShowing) { judgeShowing = false; showNextJudge(); }
      }, 180);
    }, 1500);
  }

  function showSkillBanner(text) {
    if (!els.skillBanner) return;
    const m = /(.+?)\s*发动【(.+?)】/.exec(String(text || ''));
    if (!m) return;
    const owner = m[1].trim();
    const skill = m[2];
    // 原版：最多 3 行并发，纯文字、无底板，2000ms 后逐行消失
    const line = document.createElement('div');
    line.className = 'skill-line';
    line.innerHTML = '<span class="sl-owner">' + esc(owner) + '</span> 发动【<b>' + esc(skill) + '</b>】';
    els.skillBanner.appendChild(line);
    while (els.skillBanner.children.length > 3) els.skillBanner.removeChild(els.skillBanner.firstChild);
    setTimeout(function () {
      if (!line.parentNode) return;
      line.classList.add('is-out');
      setTimeout(function () { if (line.parentNode) line.parentNode.removeChild(line); }, 260);
    }, 2000);
  }

  /* ---------- 顶栏 ---------- */
  function renderTop(g) {
    if (!els.tbDeck) return;
    els.tbDeck.textContent = (g.deck || []).length;
    els.tbDiscard.textContent = (g.discardPile || []).length;
    els.tbTurn.textContent = g.turnCount || 0;
    const phase = PHASE_CN[g.phase] || '准备';
    els.tbPhase.textContent = phase;

    let prompt = '';
    const req = pending && pending.req;
    if (req) {
      if (req.type === 'play') prompt = sel.action ? ('已选：' + sel.action.label) : ((g.mode === '1v1' ? '单挑 · ' : (g.mode === 'ddz' ? '斗地主 · ' : '')) + '轮到你出牌');
      else prompt = req.reason || TYPE_TITLE[req.type] || '请操作';
    } else if (!g.players || !g.players.length) {
      prompt = '正在整备牌局…';
    } else {
      const cur = g.players[g.currentSeat];
      if (!cur) prompt = '等待开始…';
      else if (!cur.alive) prompt = '等待其他角色行动…';
      else prompt = (cur.isHuman ? '你的回合' : displayName(cur) + ' 的' + phase + ' · 思考中…');
    }
    if (g.ddzMode && g.ddzMultiplier) prompt += ' · 倍率 ×' + g.ddzMultiplier;
    if (g.ddzMode && g.ddzFierce) prompt += ' · 鏖战';
    if (els.tbPrompt.textContent !== prompt) els.tbPrompt.textContent = prompt;
    els.tbPrompt.title = prompt;

    els.tbPhase.classList.toggle('is-yours', !!(req && req.type !== 'chooseGeneral'));
  }

  /* ---------- 对手座位 ---------- */
  function ensureSeats(g) {
    if (seatGame === g) return;
    seatGame = g;
    seatEls.clear();
    els.seats.innerHTML = '';
    if (!g.players || !g.players.length) return;
    const opp = g.players.filter(function (p) { return p.seat !== humanSeat; });
    const phonePortrait = global.innerWidth <= 480 && global.innerHeight > global.innerWidth;
    const phoneLandscape = global.innerWidth > global.innerHeight && global.innerHeight <= 520 && global.innerWidth <= 1100;
    const P = phonePortrait;
    const L = phoneLandscape;
    const pos = L
      ? (opp.length === 7 ? POS_8_L : opp.length === 4 ? POS_5_L : opp.length === 2 ? POS_2_L : opp.length === 3 ? POS_4_L : opp.length === 5 ? POS_6_L : opp.length === 1 ? POS_1 : null)
      : P
        ? (opp.length === 7 ? POS_8_P : opp.length === 4 ? POS_5_P : opp.length === 2 ? POS_2_P : opp.length === 3 ? POS_4_P : opp.length === 5 ? POS_6_P : opp.length === 1 ? POS_1 : null)
        : (opp.length === 7 ? POS_8 : (opp.length === 4 ? POS_5 : (opp.length === 2 ? POS_2 : (opp.length === 3 ? POS_4 : (opp.length === 5 ? POS_6 : (opp.length === 1 ? POS_1 : null))))));
    opp.forEach(function (p, i) {
      let x = 50, y = 50;
      if (pos && pos[i]) { x = pos[i][0]; y = pos[i][1]; }
      else {
        const ang = Math.PI / 2 + (i + 1) * (Math.PI * 2 / (opp.length + 1));
        x = 50 + Math.cos(ang) * 38;
        y = 48 - Math.sin(ang) * 34;
      }
      const root = document.createElement('div');
      root.className = 'seat';
      root.dataset.seat = String(p.seat);
      root.style.setProperty('--x', x + '%');
      root.style.setProperty('--y', y + '%');
      // 装备挂件朝牌桌中心一侧：左座挂右、右座挂左、中座挂下
      root.classList.toggle('eq-right', x < 38);
      root.classList.toggle('eq-left', x > 62);
      root.classList.toggle('eq-bottom', x >= 38 && x <= 62);
      root.innerHTML =
        '<div class="seat-art"><img alt=""></div>' +
        '<div class="seat-veil"></div>' +
        '<div class="seat-frame"></div>' +
        '<div class="seat-role"></div>' +
        '<div class="seat-hand"></div>' +
        '<div class="seat-mid">' +
        '  <div class="seat-eqs"></div>' +
        '  <div class="seat-jds"></div>' +
        '  <div class="seat-badges"></div>' +
        '</div>' +
        '<div class="seat-hp"></div>' +
        '<div class="seat-name"></div>' +
        '<div class="seat-kingdom"></div>' +
        '<div class="seat-equip-list"></div>' +
        '<div class="seat-distance"></div>' +
        '<div class="seat-target-order"></div>';
      root.__ref = {
        img: root.querySelector('.seat-art img'),
        role: root.querySelector('.seat-role'),
        hand: root.querySelector('.seat-hand'),
        eqs: root.querySelector('.seat-equip-list'),
        jds: root.querySelector('.seat-jds'),
        badges: root.querySelector('.seat-badges'),
        hp: root.querySelector('.seat-hp'),
        name: root.querySelector('.seat-name'),
        kd: root.querySelector('.seat-kingdom'),
        dist: root.querySelector('.seat-distance'),
        order: root.querySelector('.seat-target-order'),
      };
      const roleEl = root.querySelector('.seat-role');
      if (roleEl) {
        roleEl.title = (game && game.mode === 'ddz') ? '身份公开' : ((game && game.teamMode) ? '队伍身份' : '点击标记身份（仅自己可见）');
        roleEl.addEventListener('click', function (e) {
          e.stopPropagation();
          if (!game || game.mode === '1v1' || game.mode === 'ddz' || game.teamMode || game.over) return;
          const order = ['', 'loyalist', 'rebel', 'renegade'];
          const cur = seatMarks[p.seat] || '';
          seatMarks[p.seat] = order[(order.indexOf(cur) + 1) % order.length];
          render(game);
        });
      }
      root.addEventListener('mouseenter', function () { hoverSeat = p.seat; drawAim(); });
      root.addEventListener('mouseleave', function () { if (hoverSeat === p.seat) { hoverSeat = null; drawAim(); } });
      els.seats.appendChild(root);
      seatEls.set(p.seat, root);
    });
    drawAim();
  }

  function roleLabelFor(g, p) {
    if (!p) return '';
    if (g && (g.mode === 'ddz' || g.ddzMode)) return g.roleName(p.role);
    if (g && g.mode === '1v1') return '';
    if (g && g.teamMode) return g.teamName(p.role);
    if (p.isHuman) return g.roleName(p.role);
    if (p.role === 'lord' || p.revealed || !p.alive) return g.roleName(p.role);
    const mk = seatMarks[p.seat];
    if (mk) return { loyalist: '忠', rebel: '反', renegade: '内' }[mk] || '？';
    return '？';
  }

  function roleClassOf(g, p) {
    if (!p) return '';
    // 队伍/斗地主身份是公开信息，优先按公开阵营着色
    if (g.teamMode) return p.role === 'team0' ? ' is-team0' : p.role === 'team1' ? ' is-team1' : '';
    if (g.ddzMode) return p.role === 'landlord' ? ' is-role-landlord' : ' is-role-farmer';
    if (!p.alive || p.isHuman || p.role === 'lord' || p.revealed) {
      return p.role ? ' is-role-' + p.role : '';
    }
    return ' is-role-unknown';
  }

  function actionHasTargets(t) {
    return !!(t && ((t.targetCandidates && t.targetCandidates.length > 0) || (t.minTargets || 0) > 0 || (t.maxTargets || 0) > 0));
  }

  function aimAnchor(seat) {
    if (seat === humanSeat) return els.mePortrait;
    return seatEls.get(seat);
  }

  function anchorPoint(el, layerRect) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - layerRect.left + r.width / 2, y: r.top - layerRect.top + r.height * 0.40 };
  }

  function seatAimPoint(seat) {
    const root = seatEls.get(seat);
    if (!root) return null;
    const r = root.getBoundingClientRect();
    const lr = els.aim ? els.aim.getBoundingClientRect() : { left: 0, top: 0 };
    return { x: r.left - lr.left + r.width / 2, y: r.top - lr.top + r.height * 0.42 };
  }

  function flashArrows(fromSeat, toSeats) {
    if (!toSeats || !toSeats.length || !els.aim) return;
    const now = Date.now();
    transientAim = transientAim.filter(function (a) { return a.until > now; });
    toSeats.forEach(function (to) {
      if (to == null || to === fromSeat) return;
      transientAim.push({ from: fromSeat, to: to, until: now + 900 });
    });
    drawAim();
    if (flashAimTimer) clearTimeout(flashAimTimer);
    flashAimTimer = setTimeout(function () { flashAimTimer = 0; drawAim(); }, 950);
  }

  function aimPath(sx, sy, tx, ty, bendScale, cls, marker) {
    const dx = tx - sx, dy = ty - sy;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const bend = Math.min(92, dist * (bendScale == null ? 0.18 : bendScale));
    const mx = (sx + tx) / 2 + (-dy / dist) * bend;
    const my = (sy + ty) / 2 + (dx / dist) * bend;
    return '<path d="M ' + sx.toFixed(1) + ' ' + sy.toFixed(1) +
      ' Q ' + mx.toFixed(1) + ' ' + my.toFixed(1) +
      ' ' + tx.toFixed(1) + ' ' + ty.toFixed(1) + '" class="' + cls + '"' +
      (marker ? ' marker-end="url(#' + marker + ')"' : '') + '/>';
  }

  function aimDefs() {
    return '<defs>' +
      '<marker id="aimArrowGold" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="rgba(255,214,110,.95)"/></marker>' +
      '<marker id="aimArrowWhite" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="rgba(255,250,220,.95)"/></marker>' +
      '</defs>';
  }

  function drawAim() {
    if (!els.aim) return;
    const trans = transientAim.filter(function (a) { return a.until > Date.now(); });
    const req = pending && pending.req;
    const active = req && req.type === 'play' && sel.action && actionHasTargets(sel.action);
    if ((!active && !trans.length) || !game || screen !== 'game' || (els.modalRoot && els.modalRoot.children.length)) {
      if (els.aim.childNodes.length) els.aim.innerHTML = '';
      if (els.dragon && els.dragon.childNodes.length) els.dragon.innerHTML = '';
      return;
    }
    const lr = els.aim.getBoundingClientRect();
    let html = aimDefs();
    // AI / 人类出牌的瞬时箭头
    trans.forEach(function (t) {
      const a = anchorPoint(aimAnchor(t.from), lr);
      const b = anchorPoint(aimAnchor(t.to), lr);
      if (!a || !b) return;
      html += aimPath(a.x, a.y, b.x, b.y, 0, 'is-transient', null);
      html += aimPath(a.x, a.y, b.x, b.y, 0, 'is-transient-core', null);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 - 8;
    });
    if (active && sel.action && sel.action.as === 'tiesuo') {
      // 铁索不画指向箭头，只高亮目标；确认后播放锁链特效
      els.aim.innerHTML = html;
      return;
    }
      const pr = els.mePortrait.getBoundingClientRect();
      const sx = pr.left - lr.left + pr.width / 2;
      const sy = pr.top - lr.top + 12;
      if (sel.action && sel.action.as === 'jiedao' && sel.targets.length >= 1) {
        // 借刀：人类 → 持武器者，持武器者 → 被杀者/候选
        const holder = sel.targets[0];
        const hp = seatAimPoint(holder);
        if (!hp) {
          // 保底：座位尚未渲染时仍走普通线
        } else {
          html += aimPath(sx, sy, hp.x, hp.y, 0, 'is-picked', null);
          html += aimPath(sx, sy, hp.x, hp.y, 0, 'is-core', null);
          const second = sel.targets[1] != null ? sel.targets[1] : null;
          const secondPoint = second != null ? seatAimPoint(second) : null;
          if (secondPoint) {
            html += aimPath(hp.x, hp.y, secondPoint.x, secondPoint.y, 0, 'is-picked', null);
            html += aimPath(hp.x, hp.y, secondPoint.x, secondPoint.y, 0, 'is-core', null);
          } else {
            const cands = targetCandidates();
            const hover = (hoverSeat != null && cands.indexOf(hoverSeat) >= 0 && hoverSeat !== holder) ? hoverSeat : null;
            cands.forEach(function (seat) {
              if (seat === holder || seat === hover) return;
              const pt = seatAimPoint(seat); if (!pt) return;
              html += aimPath(hp.x, hp.y, pt.x, pt.y, 0, 'is-candidate', null);
            });
            if (hover != null) {
              const pt = seatAimPoint(hover);
              if (pt) {
                html += aimPath(hp.x, hp.y, pt.x, pt.y, 0, 'is-hover', null);
                html += aimPath(hp.x, hp.y, pt.x, pt.y, 0, 'is-core', null);
              }
            }
          }
        }
      } else {
      const pr = els.mePortrait.getBoundingClientRect();
      const sx = pr.left - lr.left + pr.width / 2;
      const sy = pr.top - lr.top + 12;
      const cands = targetCandidates();
      const picked = sel.targets.slice();
      const hover = (hoverSeat != null && cands.indexOf(hoverSeat) >= 0 && picked.indexOf(hoverSeat) < 0) ? hoverSeat : null;
      cands.forEach(function (seat) {
        if (picked.indexOf(seat) >= 0 || seat === hover) return;
        const root = seatEls.get(seat); if (!root) return;
        const r = root.getBoundingClientRect();
        html += aimPath(sx, sy, r.left - lr.left + r.width / 2, r.top - lr.top + r.height * 0.42, 0, 'is-candidate', null);
      });
      picked.forEach(function (seat) {
        const root = seatEls.get(seat); if (!root) return;
        const r = root.getBoundingClientRect();
        html += aimPath(sx, sy, r.left - lr.left + r.width / 2, r.top - lr.top + r.height * 0.42, 0, 'is-picked', null);
        html += aimPath(sx, sy, r.left - lr.left + r.width / 2, r.top - lr.top + r.height * 0.42, 0, 'is-core', null);
      });
      if (hover != null) {
        const root = seatEls.get(hover);
        if (root) {
          const r = root.getBoundingClientRect();
          html += aimPath(sx, sy, r.left - lr.left + r.width / 2, r.top - lr.top + r.height * 0.42, 0, 'is-hover', null);
          html += aimPath(sx, sy, r.left - lr.left + r.width / 2, r.top - lr.top + r.height * 0.42, 0, 'is-core', null);
        }
      }
      }
    els.aim.innerHTML = html;
    drawDragons(trans, lr);
  }

  function drawDragons(trans, lr) {
    if (!els.dragon) return;
    els.dragon.innerHTML = '';
    if (!trans || !trans.length) return;
    trans.forEach(function (t) {
      const src = game && game.players ? game.players[t.from] : null;
      const gen = src && src.general;
      // 原版：Seat.Gradation >= MinLineEffectGradation(4) 才叠金龙
      if (!gen || (gen.gradation || 0) < 4) return;
      const a = anchorPoint(aimAnchor(t.from), lr);
      const b = anchorPoint(aimAnchor(t.to), lr);
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;
      const w = Math.min(Math.max(dist * 0.58, 80), 240);
      const h = Math.min(96, Math.max(40, w * 0.45));
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const el = document.createElement('div');
      el.className = 'aim-dragon';
      el.style.left = cx + 'px';
      el.style.top = cy + 'px';
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      el.style.transform = 'translate(-50%,-50%) rotate(' + ang + 'deg) scaleX(-1)';
      els.dragon.appendChild(el);
    });
  }

  function targetCandidates() {
    const t = sel.action;
    if (!t || !game || !game.players) return [];
    let base = (t.targetCandidates || []).slice();
    if (t.secondStage === 'jiedao' && sel.targets.length >= 1 && typeof game.legalSecondTargetsFor === 'function') {
      const second = game.legalSecondTargetsFor(game.players[humanSeat], 'jiedao', sel.targets[0]) || [];
      if (second.length) base = second;
    } else if (t.ordered && sel.targets.length >= 1 && (t.as === 'lijian' || t.skill === 'lijian') && typeof game.legalSecondTargetsFor === 'function') {
      const second = game.legalSecondTargetsFor(game.players[humanSeat], 'lijian', sel.targets[0]) || [];
      if (second.length) base = second;
    }
    return base.filter(function (s) { return game.players[s] && game.players[s].alive; });
  }

  function targetRejectInfo(seat) {
    const t = sel.action;
    const me = game && game.players ? game.players[humanSeat] : null;
    const p = game && game.players ? game.players[seat] : null;
    if (!t || !me || !p) return { text: '无法指定该角色为目标' };
    if (seat === humanSeat) return { text: '不能以自己为目标' };
    if (!p.alive) return { text: '该角色已阵亡' };
    const as = t.as || '';
    const skill = t.skill || '';
    const d = game.distance(me, p);
    const range = game.attackRange(me);
    const skills = p.skills || [];
    const shaLike = ['sha', 'huosha', 'leisha'].indexOf(as) >= 0;
    if (shaLike && d > range) {
      return { distance: true, d: d, range: range, text: '距离不足：' + displayName(p) + ' 距离 ' + d + '，你的攻击范围 ' + range };
    }
    if (as === 'shunshou' && d > 1 && (me.skills || []).indexOf('qicai') < 0) {
      return { distance: true, d: d, range: 1, text: '距离不足：顺手牵羊只能指定距离 1 内的角色' };
    }
    if (as === 'bingliang' && d > 1) {
      return { distance: true, d: d, range: 1, text: '距离不足：兵粮寸断只能指定距离 1 内的角色' };
    }
    if (t.secondStage === 'jiedao' && sel.targets.length >= 1) {
      return { text: '该角色不在持刀者的攻击范围内' };
    }
    if (skill === 'lijian') return { text: '离间只能指定男性角色' };
    if (skill === 'jieyin') return { text: '结姻只能指定已受伤的男性角色' };
    if (skill === 'qingnang') return { text: '该角色体力已满，无需回复' };
    if (skill === 'quhu') return { text: '驱虎只能指定体力高于你的角色' };
    if ((skill === 'qiangxi' || skill === 'tiaoxin') && d > range) {
      return { distance: true, d: d, range: range, text: '距离不足：该角色不在你的攻击范围内' };
    }
    if (skill === 'zhiba') return { text: '制霸只能对主公孙策发动' };
    if (as === 'guohe' || as === 'shunshou') {
      if (!p.hand.length && !Object.values(p.equips || {}).some(Boolean) && !(p.judges || []).length) {
        return { text: '该角色区域内没有可选的牌' };
      }
    }
    if (as === 'jiedao') return { text: '该角色没有装备武器牌' };
    if (as === 'huogong' && !p.hand.length) return { text: '该角色没有手牌，无法火攻' };
    if (as === 'lebu' && (p.judges || []).some(function (c) { return c.name === 'lebu'; })) {
      return { text: '该角色判定区已有【乐不思蜀】' };
    }
    if (as === 'bingliang' && (p.judges || []).some(function (c) { return c.name === 'bingliang'; })) {
      return { text: '该角色判定区已有【兵粮寸断】' };
    }
    if (skills.indexOf('kongcheng') >= 0 && !p.hand.length && (as === 'sha' || as === 'juedou')) {
      return { text: '【空城】使该角色不能成为目标' };
    }
    if (skills.indexOf('weimu') >= 0 && as && CARDS[as] && CARDS[as].type === 'trick') {
      return { text: '【帷幕】使该角色不能成为黑色锦囊目标' };
    }
    if (skills.indexOf('qianxun') >= 0 && (as === 'lebu' || as === 'shunshou')) {
      return { text: '【谦逊】使该角色不能成为目标' };
    }
    return { text: '无法指定该角色为目标' };
  }

  function renderSeats(g) {
    if (!g.players || !g.players.length) return;
    ensureSeats(g);
    const ctReq = pending && pending.req && pending.req.type === 'chooseTargets' ? pending.req : null;
    const targeting = (pending && pending.req && pending.req.type === 'play' && sel.action && actionHasTargets(sel.action)) || !!ctReq;
    const cands = ctReq ? (ctReq.candidates || []) : (targeting ? targetCandidates() : []);
    const pickedSeats = ctReq && tablePick ? tablePick.selected : sel.targets;
    g.players.forEach(function (p) {
      if (p.seat === humanSeat) return;
      const root = seatEls.get(p.seat);
      if (!root) return;
      const ref = root.__ref;
      const gen = p.general;
      const color = kingdomColor(p.kingdom || (gen && gen.kingdom));

      if (gen) {
        const want = seatImg(gen.id);
        if (ref.img.getAttribute('src') !== want) ref.img.setAttribute('src', want);
        ref.img.style.visibility = '';
      } else {
        ref.img.removeAttribute('src');
        ref.img.style.visibility = 'hidden';
      }

      root.style.setProperty('--k', color);
      root.classList.toggle('seat-dead', !p.alive);
      root.classList.toggle('is-chained', !!p.chained);
      root.classList.toggle('seat-active', !g.over && g.currentSeat === p.seat && p.alive);
      const groupWaiting = g.groupWaiting || [];
      const waitReq = pending && pending.req && pending.req.type === 'response' ? pending.req : null;
      root.classList.toggle('seat-group-wait', groupWaiting.indexOf(p.seat) >= 0);
      root.classList.toggle('seat-waiting', !!(waitReq && waitReq.player === p));

      const roleTxt = roleLabelFor(g, p);
      if (ref.role.textContent !== roleTxt) ref.role.textContent = roleTxt;
      const mk = seatMarks[p.seat];
      ref.role.className = 'seat-role' + roleClassOf(g, p) +
        (p.role === 'lord' ? ' is-lord' : '') +
        (!p.alive ? ' is-dead' : '') +
        ((roleTxt === '?' || roleTxt === '？') ? ' is-unknown' : '') +
        (mk && p.alive && !p.revealed && p.role !== 'lord' ? ' is-marked mark-' + mk : '');
      ref.role.style.cursor = (g.mode !== '1v1' && !g.teamMode && p.alive && p.role !== 'lord') ? 'pointer' : '';

      const handCount = p.hand ? p.hand.length : 0;
      setHTML(ref.hand, String(handCount));
      // 斗地主农民互看：队友手牌可悬停查看，地主/非 ddz 不暴露
      let seeHand = false;
      try { seeHand = !!(game.canSeeHand && game.canSeeHand(game.players[humanSeat], p)); } catch (e) { seeHand = false; }
      ref.hand.classList.toggle('is-open-hand', seeHand && p.seat !== humanSeat);
      if (seeHand && p.seat !== humanSeat) {
        const names = (p.hand || []).map(function (c) {
          const d = cardDef(c.name); const su = suitOf(c);
          return (d.name || c.name) + (su ? su.cn + rankCn(c.rank) : '');
        });
        const tip = names.length ? '队友手牌：' + names.join('、') : '队友手牌：无';
        ref.hand.setAttribute('data-tip', tip);
        ref.hand.title = tip;
      } else {
        ref.hand.removeAttribute('data-tip');
        ref.hand.title = '手牌 ' + handCount;
      }
      setHTML(ref.hp, beadsHTML(Math.max(0, p.hp), p.maxHp, ''));
      setHTML(ref.name, esc(displayName(p)) + '<span class="seat-hpnum">' + Math.max(0, p.hp) + '/' + p.maxHp + '</span>');
      if (ref.kd.textContent !== (p.kingdom || (gen && gen.kingdom) || '')) {
        ref.kd.textContent = p.kingdom || (gen && gen.kingdom) || '';
        ref.kd.style.background = color;
      }

      const eqHTML = SLOTS.map(function (slot) {
        const c = p.equips && p.equips[slot];
        if (!c) return '';
        const su = suitOf(c);
        return '<span class="eq-bar" data-tip="' + esc(cardDef(c.name).name + '（' + SLOT_CN[slot] + '）：' + cardDef(c.name).desc) + '">' +
          '<img class="eq-ico" src="' + cardImgOf(c) + '" alt="">' +
          '<b class="eq-sr" style="color:' + suitColor(c) + '">' + (su ? su.cn : '') + rankCn(c.rank) + '</b>' +
          '<em class="eq-name">' + esc(cardDef(c.name).name) + '</em></span>';
      }).join('');
      setHTML(ref.eqs, eqHTML);

      const jdHTML = (p.judges || []).map(function (c) {
        const def = cardDef(c.name);
        return '<i class="jd-dot" data-tip="' + esc(cardTip(c)) + '">' + (JUDGE_SHORT[c.name] || def.name.slice(0, 1)) + '</i>';
      }).join('');
      setHTML(ref.jds, jdHTML);

      const badges = [];
      if (p.chained) badges.push('<span class="badge-mini is-chain">横置</span>');
      if (p.flipped) badges.push('<span class="badge-mini is-flip">翻面</span>');
      if (p.marks && p.marks.tian) badges.push('<span class="badge-mini is-tian">田×' + p.marks.tian + '</span>');
      if (p.marks && Array.isArray(p.marks.buqu) && p.marks.buqu.length) badges.push('<span class="badge-mini is-buqu">不屈×' + p.marks.buqu.length + '</span>');
      if (p.marks && p.marks.huashen && p.marks.huashen.options) badges.push('<span class="badge-mini">化身</span>');
      if (!p.isHuman && !g.over && g.currentSeat === p.seat) badges.push('<span class="badge-mini is-thinking"><i></i>思考中</span>');
      setHTML(ref.badges, badges.join(''));

      const isCand = cands.indexOf(p.seat) >= 0 && p.alive;
      const isPicked = pickedSeats.indexOf(p.seat) >= 0;
      root.classList.toggle('seat-targetable', !!targeting && isCand && !isPicked);
      root.classList.toggle('seat-picked', isPicked);
      root.classList.toggle('seat-dim', !!targeting && !isCand && !isPicked);
      if (targeting && p.alive && !isCand) {
        const reject = targetRejectInfo(p.seat);
        ref.dist.textContent = reject.distance ? '距离不足' : '不可选';
        ref.dist.title = reject.text || '';
        ref.dist.setAttribute('data-tip', reject.text || '无法指定该角色为目标');
        ref.dist.classList.add('is-warn');
      } else {
        ref.dist.textContent = isCand ? '距离 ' + g.distance(g.players[humanSeat], p) : '';
        ref.dist.title = '';
        ref.dist.removeAttribute('data-tip');
        ref.dist.classList.remove('is-warn');
      }
      ref.dist.style.opacity = (isCand || (targeting && p.alive)) ? '1' : '0';
      ref.order.textContent = isPicked ? String(pickedSeats.indexOf(p.seat) + 1) : '';

      const tip = (gen ? gen.name + ' · ' + gen.kingdom + ' · 体力 ' + Math.max(0, p.hp) + '/' + p.maxHp : '未选将') +
        (gen && gen.title ? '\n' + gen.title : '') +
        (p.secondGeneral ? '\n副将：' + p.secondGeneral.name : '') +
        (p.isHuman ? '' : '\n身份：' + roleLabelFor(g, p)) +
        ((gen && gen.skills || []).length ? '\n技能：' + gen.skills.map(function (id) { return skillName(id); }).join('、') : '') +
        '\n长按/右键查看技能';
      root.setAttribute('data-tip', tip);
    });
    drawAim();
  }

  /* ---------- 自己 ---------- */
  function renderMe(g) {
    if (!els.meName) return;
    const me = g.players[humanSeat];
    if (!me) return;
    const gen = me.general;
    const artKey = gen ? (gen.id + '|' + gen.name) : 'none';
    if (artKey !== meArtKey) {
      meArtKey = artKey;
      els.meArt.innerHTML = gen
        ? '<img src="' + bigImg(gen.id) + '" alt="" onerror="this.onerror=null;this.src=\'' + seatImg(gen.id) + '\'">'
        : '';
    }
    if (els.meName.textContent !== (gen ? gen.name : '—')) els.meName.textContent = gen ? gen.name : '—';
    els.meTitle.textContent = gen ? ((gen.title || '') + (me.secondGeneral ? ' · 副将 ' + me.secondGeneral.name : '')) : '';
    els.meKingdom.textContent = gen ? gen.kingdom : '';
    els.meKingdom.style.background = kingdomColor(gen && gen.kingdom);

    const roleTxt = g.mode === '1v1' ? '' : roleLabelFor(g, me);
    if (els.meRole.textContent !== roleTxt) els.meRole.textContent = roleTxt;
    const meLordLike = me.role === 'lord' || (g.mode === 'ddz' && me.role === 'landlord');
    els.meRole.className = 'pf-role' + roleClassOf(g, me) + (meLordLike ? ' is-lord' : '') + (!me.alive ? ' is-dead' : '');

    setHTML(els.meHp, beadsHTML(Math.max(0, me.hp), me.maxHp, '') + '<span class="hp-num">' + Math.max(0, me.hp) + ' / ' + me.maxHp + '</span>');

    const st = [];
    if (me.chained) st.push('<span class="badge-mini is-chain">横置</span>');
    if (me.flipped) st.push('<span class="badge-mini is-flip">翻面</span>');
    if (me.alive && me.hp <= 0) st.push('<span class="badge-mini is-buqu">濒死</span>');
    setHTML(els.meStatus, st.join(''));

    const ctReqMe = pending && pending.req && pending.req.type === 'chooseTargets' ? pending.req : null;
    const targeting = (pending && pending.req && pending.req.type === 'play' && sel.action && actionHasTargets(sel.action)) || !!ctReqMe;
    const cands = ctReqMe ? (ctReqMe.candidates || []) : (targeting ? targetCandidates() : []);
    const isCand = cands.indexOf(me.seat) >= 0 && me.alive;
    const isPicked = (ctReqMe && tablePick ? tablePick.selected : sel.targets).indexOf(me.seat) >= 0;
    els.mePortrait.classList.toggle('is-active', !g.over && g.currentSeat === me.seat && me.alive);
    const groupWaitingMe = g.groupWaiting || [];
    const waitReqMe = pending && pending.req && pending.req.type === 'response' ? pending.req : null;
    els.mePortrait.classList.toggle('is-group-wait', groupWaitingMe.indexOf(me.seat) >= 0);
    els.mePortrait.classList.toggle('is-waiting', !!(waitReqMe && waitReqMe.player === me));
    els.mePortrait.classList.toggle('is-targetable', !!targeting && isCand && !isPicked);
    els.mePortrait.classList.toggle('is-picked', isPicked);
    els.mePortrait.classList.toggle('is-dead', !me.alive);

    // 技能
    const skills = (me.skills || (gen && gen.skills) || []).slice();
    const playTmpl = {};
    if (pending && pending.req && pending.req.type === 'play') {
      (pending.req.actions || []).forEach(function (a) { if (a.kind === 'skill') playTmpl[a.skill] = a; });
    }
    const skillSig = skills.join(',') + '|' + Object.keys(playTmpl).join(',') + '|' + me.alive + '|' + (pending && pending.req ? pending.req.type : '') + '|' + g.phase;
    if (skillSig !== last.skillSig) {
      last.skillSig = skillSig;
      if (!skills.length) {
        setHTML(els.meSkills, '<span class="judge-empty">无</span>');
      } else {
        els.meSkills.innerHTML = skills.map(function (id) {
          const ready = !!playTmpl[id] && me.alive;
          const desc = skillDesc(id);
          const tip = skillName(id) + (desc ? '：' + desc : '');
          return '<button class="skill-btn' + (ready ? ' is-ready' : ' is-passive') + '" data-skill="' + esc(id) + '" data-tip="' + esc(tip) + '">' +
            '<span class="sk-dot"></span>' + esc(skillName(id)) + '</button>';
        }).join('');
      }
    }

    // 装备
    const eqSig = SLOTS.map(function (s2) { return me.equips && me.equips[s2] ? me.equips[s2].id : '-'; }).join(',');
    if (eqSig !== last.equipSig) {
      last.equipSig = eqSig;
      els.meEquips.innerHTML = SLOTS.map(function (slot) {
        const c = me.equips && me.equips[slot];
        if (c) {
          const def = cardDef(c.name);
          const tip = def.name + '（' + SLOT_CN[slot] + '）\n' + (def.desc || '');
          return '<div class="equip-slot is-filled" data-slot="' + slot + '" data-tip="' + esc(tip) + '">' +
            cardImgTag(c) +
            '<span class="eq-name">' + esc(def.name) + '</span>' +
            '<span class="eq-short">' + esc(def.name.slice(0, 2)) + '</span></div>';
        }
        return '<div class="equip-slot is-empty" data-slot="' + slot + '" data-tip="' + SLOT_CN[slot] + '：空"><span class="eq-glyph">' + SLOT_GLYPH[slot] + '</span><span class="eq-label">' + SLOT_CN[slot] + '</span></div>';
      }).join('');
    }

    // 判定区
    const jdSig = (me.judges || []).map(function (c) { return c.id; }).join(',');
    if (jdSig !== last.judgeSig) {
      last.judgeSig = jdSig;
      if (!(me.judges || []).length) {
        els.meJudges.innerHTML = '<span class="judge-empty">无</span>';
      } else {
        els.meJudges.innerHTML = me.judges.map(function (c) {
          const def = cardDef(c.name);
          return '<div class="judge-chip" data-tip="' + esc(cardTip(c)) + '">' +
            cardImgTag(c) + esc(def.name) + '</div>';
        }).join('');
      }
    }

    const marks = [];
    if (me.marks && me.marks.tian) marks.push('田 × ' + me.marks.tian);
    if (me.marks && Array.isArray(me.marks.buqu) && me.marks.buqu.length) marks.push('不屈 × ' + me.marks.buqu.length);
    if (me.marks && me.marks.huashen && me.marks.huashen.options) marks.push('化身已展示');
    setHTML(els.meMarks, marks.map(function (t) { return '<span class="badge-mini">' + esc(t) + '</span>'; }).join(''));
  }

  /* ---------- 手牌 ---------- */
  function renderHand(g) {
    if (!els.hand) return;
    const me = g.players[humanSeat];
    if (!me) return;
    const hand = me.hand || [];
    const sig = hand.map(function (c) { return c.id; }).join(',');
    if (sig !== last.handSig) {
      last.handSig = sig;
      els.hand.innerHTML = hand.map(function (c) {
        const def = cardDef(c.name);
        const s = suitOf(c);
        return '<div class="hand-card" data-cid="' + c.id + '">' +
          cardImgTag(c) +
          (s ? '<span class="hc-suit" style="color:' + suitColor(c) + '">' + s.cn + '</span>' : '') +
          '<span class="hc-rank">' + esc(rankCn(c.rank)) + '</span>' +
          '<span class="hc-name">' + esc(def.name) + '</span>' +
          '<span class="hc-check">✓</span>' +
          '</div>';
      }).join('');
      const wrap = els.hand.parentElement;
      if (wrap && wrap.clientWidth > 60) { layoutHand(); handDirty = false; }
      else handDirty = true;
    }
    syncHandClasses(g, hand);
    if (handDirty && screen === 'game') { layoutHand(); handDirty = false; }
  }

  function actionCardSet(g) {
    const req = pending && pending.req;
    if (!req || req.type !== 'play') return null;
    if (!sel.action) {
      const set = new Set();
      (req.actions || []).forEach(function (a) {
        if (a.kind === 'card' && a.subcards) a.subcards.forEach(function (id) { set.add(id); });
      });
      return set;
    }
    if (sel.action.kind === 'card') return new Set(sel.action.subcards || []);
    if (sel.action.needsCards) return null; // 技能选牌：全部可选（同花色另判）
    return new Set();
  }

  function syncHandClasses(g, hand) {
    const req = pending && pending.req;
    const playSet = actionCardSet(g);
    const alone = !req;
    const responseOpts = req && req.type === 'response' ? req.options || [] : [];
    const respSet = new Set(responseOpts.map(function (o) { return o.cardId; }));
    const firstSuit = (sel.action && sel.action.sameSuit && sel.cards.length)
      ? (hand.find(function (c) { return c.id === sel.cards[0]; }) || {}).suit : null;

    Array.prototype.forEach.call(els.hand.children, function (el) {
      const cid = Number(el.dataset.cid);
      const card = hand.find(function (c) { return c.id === cid; });
      let selected = sel.cards.indexOf(cid) >= 0 || (respSel && respSel.cardId === cid);
      let usable = false;
      let unusable = false;
      let dim = false;

      if (alone) {
        usable = false;
      } else if (req.type === 'response') {
        usable = respSet.has(cid);
        unusable = !usable;
      } else if (req.type === 'chooseCards' && handPickMode(req)) {
        const pickSet = new Set((req.cards || []).map(function (c) { return c.id; }));
        selected = !!(handPickState() && handPickState().selected.indexOf(cid) >= 0);
        usable = pickSet.has(cid);
        unusable = !usable;
      } else if (req.type === 'play') {
        if (!sel.action) {
          usable = !!(playSet && playSet.has(cid));
          unusable = !usable;
        } else if (sel.action.kind === 'skill' && sel.action.needsCards) {
          usable = true;
          if (sel.action.sameSuit && firstSuit && card && card.suit !== firstSuit && !selected) { dim = true; unusable = true; }
        } else if (sel.action.kind === 'card') {
          dim = !selected;
        } else {
          dim = true;
        }
      }
      el.classList.toggle('is-selected', !!selected);
      el.classList.toggle('is-usable', !!usable && !selected);
      el.classList.toggle('is-unusable', !!unusable && !selected);
      el.classList.toggle('is-dim', !!dim && !selected);
    });
  }

  let layoutRaf = 0;
  function scheduleLayout() {
    if (layoutRaf) return;
    layoutRaf = global.requestAnimationFrame(function () {
      layoutRaf = 0;
      if (screen === 'game') layoutHand();
    });
  }

  function layoutHand() {
    if (!els.hand) return;
    const wrap = els.hand.parentElement;
    const cards = Array.prototype.slice.call(els.hand.children);
    const n = cards.length;
    if (!wrap || !n) return;
    if (wrap.clientWidth < 60) return;
    const cw = cards[0].offsetWidth || 104;
    const avail = Math.max(cw + 8, wrap.clientWidth - 24);
    const gap = n > 1 ? Math.max(-cw, Math.min(2, (avail - cw * n) / (n - 1))) : 0;
    const step = cw + gap;
    const total = cw + step * (n - 1);
    const start = Math.max(2, (avail - total) / 2) + 10;
    const mid = (n - 1) / 2;
    cards.forEach(function (el, i) {
      const off = i - mid;
      const rot = Math.max(-8, Math.min(8, off * 2.1));
      const y = Math.min(17, Math.abs(off) * 2.4);
      el.style.setProperty('--x', (start + step * i).toFixed(1) + 'px');
      el.style.setProperty('--rot', rot.toFixed(2) + 'deg');
      el.style.setProperty('--y', y.toFixed(1) + 'px');
      el.style.zIndex = String(10 + i);
    });
  }

  /* ---------- 操作条 ---------- */
  function handPickMode(req) {
    if (!req || req.type !== 'chooseCards' || !game) return false;
    const cards = req.cards || [];
    if (!cards.length) return false;
    const me = game.players[humanSeat];
    if (!me || !me.hand) return false;
    const ids = new Set(me.hand.map(function (c) { return c.id; }));
    return cards.every(function (c) { return ids.has(c.id); });
  }

  function handPickState() {
    const req = pending && pending.req;
    if (!handPickMode(req)) {
      if (pickState && (!pending || pickState.req !== (pending.req))) pickState = null;
      return null;
    }
    if (!pickState || pickState.req !== req) pickState = { req: req, selected: [] };
    return pickState;
  }

  function confirmHandPick() {
    const st = handPickState();
    if (!st) return false;
    const req = st.req;
    const min = req.min || 0;
    const max = req.max == null ? (req.cards || []).length : req.max;
    if (st.selected.length < min || st.selected.length > max) return false;
    resolveAnswer(st.selected.slice());
    return true;
  }

  function cancelHandPick() {
    const st = handPickState();
    if (!st) return false;
    if ((st.req.min || 0) > 0) return false;
    resolveAnswer([]);
    return true;
  }

  function renderActionBar(g) {
    if (!els.actionBar) return;
    const req = pending && pending.req;
    const me = g.players[humanSeat];
    if (!req && heldBarHTML && Date.now() < holdUntil) {
      els.actionBar.classList.add('is-holding');
      setHTML(els.actionBar, heldBarHTML);
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(function () {
        holdTimer = 0;
        if (game) renderActionBar(game);
      }, Math.max(40, holdUntil - Date.now() + 20));
      return;
    }
    els.actionBar.classList.remove('is-holding');
    let html = '';

    if (!me || !g.players.length) {
      html = barStatic('准备中', '正在整备牌局…');
    } else if (!me.alive || g.over) {
      html = barStatic('观战', '你已阵亡，等待本局结束');
    } else if (!req) {
      const cur = g.players[g.currentSeat];
      const who = cur ? (cur.isHuman ? '你' : displayName(cur)) : '—';
      html = barStatic('等待行动', who + ' 正在' + (PHASE_CN[g.phase] || '行动'));
    } else if (req.type === 'play') {
      html = barPlay(req);
    } else if (req.type === 'response') {
      html = barResponse(req);
    } else if (req.type === 'chooseGeneral') {
      html = barStatic('选择武将', '请在上方选择你的武将');
    } else if (req.type === 'chooseCards' && handPickMode(req)) {
      html = barHandPick(req);
    } else {
      html = barModalPrompt(req);
    }
    setHTML(els.actionBar, html);
  }

  function barStatic(title, sub) {
    return '<div class="bar-prompt"><div class="bar-icon">令</div><div class="bar-text">' +
      '<div class="bar-title">' + esc(title) + '</div>' +
      '<div class="bar-sub">' + esc(sub) + '</div></div></div>';
  }

  function barPlay(req) {
    const t = sel.action;
    let title, sub, btns;
    if (!t) {
      title = '出牌阶段 · 轮到你行动';
      sub = '点击手牌选择使用，或点击右侧技能；也可以直接结束出牌';
      btns = '<button class="bar-btn is-danger" data-act="play-end">结束出牌</button>';
    } else {
      title = t.label;
      const parts = [];
      if (t.needsCards) {
        parts.push('选牌 <b>' + sel.cards.length + '</b> / ' + t.needsCards.min + '–' + t.needsCards.max);
        if (t.sameSuit) parts.push('需同花色');
      }
      if ((t.maxTargets || 0) > 0 || (t.minTargets || 0) > 0) {
        parts.push('目标 <b>' + sel.targets.length + '</b> / ' + (t.minTargets || 0) + '–' + (t.maxTargets || 0));
        if (t.secondStage === 'jiedao' && sel.targets.length === 1) parts.push('再选被杀目标');
      }
      sub = parts.join(' · ') || '确认后使用';
      const ready = playReady();
      btns = '<button class="bar-btn" data-act="play-cancel">取消</button>' +
        '<button class="bar-btn is-primary" data-act="play-confirm"' + (ready ? '' : ' disabled') + '>确认</button>';
    }
    return '<div class="bar-prompt"><div class="bar-icon">杀</div><div class="bar-text">' +
      '<div class="bar-title">' + esc(title) + '</div>' +
      '<div class="bar-sub">' + sub + '</div></div></div>' +
      '<div class="bar-btns">' + btns + '</div>';
  }

  function barResponse(req) {
    const opts = req.options || [];
    let optionBtns = '';
    if (respCardId != null) {
      const variants = opts.filter(function (o) { return o.cardId === respCardId; });
      if (variants.length > 1) {
        optionBtns = variants.map(function (o, i) {
          return '<button class="bar-option" data-act="resp-pick" data-idx="' + i + '">' +
            (o.skill ? '以【' + esc(skillName(o.skill)) + '】打出' : '打出') + '</button>';
        }).join('');
      }
    }
    let selTip = opts.length ? '点击高亮手牌选择响应' : '没有可用的响应牌';
    if (respSel) {
      const me = game.players[humanSeat];
      const picked = (me.hand || []).find(function (c) { return c.id === respSel.cardId; });
      selTip = '已选：' + (picked ? cardDef(picked.name).name : '一张牌') + (respSel.skill ? '（' + skillName(respSel.skill) + '）' : '');
    }
    return '<div class="bar-prompt"><div class="bar-icon">应</div><div class="bar-text">' +
      '<div class="bar-title">' + esc(req.reason || '请响应') + '</div>' +
      '<div class="bar-sub">' + esc(selTip) + '</div></div></div>' +
      '<div class="bar-btns">' + optionBtns +
      '<button class="bar-btn is-primary" data-act="resp-confirm"' + (respSel ? '' : ' disabled') + '>打出</button>' +
      '<button class="bar-btn is-danger" data-act="resp-pass">不响应</button></div>';
  }

  function barHandPick(req) {
    const st = handPickState();
    const selected = st ? st.selected : [];
    const min = req.min || 0;
    const max = req.max == null ? (req.cards || []).length : req.max;
    const isDiscard = /弃牌阶段|弃置/.test(req.reason || '');
    const ready = selected.length >= min && selected.length <= max;
    const sub = '已选 <b>' + selected.length + '</b> / ' + (max === min ? min : (min + '–' + max)) +
      ' · ' + (selected.length ? '再次点击取消' : '点击下方手牌选择');
    const cancel = min > 0
      ? '<button class="bar-btn" data-act="pick-cancel" disabled>需选择</button>'
      : '<button class="bar-btn" data-act="pick-cancel">不下牌</button>';
    return '<div class="bar-prompt"><div class="bar-icon">' + (isDiscard ? '弃' : '选') + '</div><div class="bar-text">' +
      '<div class="bar-title">' + esc(req.reason || ('请选择 ' + min + ' 张手牌')) + '</div>' +
      '<div class="bar-sub">' + sub + '</div></div></div>' +
      '<div class="bar-btns">' + cancel +
      '<button class="bar-btn is-primary" data-act="pick-confirm"' + (ready ? '' : ' disabled') + '>' + (isDiscard ? '弃牌' : '确认') + '</button></div>';
  }

  function barModalPrompt(req) {
    return '<div class="bar-prompt"><div class="bar-icon">择</div><div class="bar-text">' +
      '<div class="bar-title">' + esc(req.reason || TYPE_TITLE[req.type] || '请操作') + '</div>' +
      '<div class="bar-sub">请在弹出的面板中完成选择</div></div></div>';
  }

  /* ---------- 操作逻辑 ---------- */
  function onActionBarClick(e) {
    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'play-end') { resolveAnswer({ kind: 'end' }); return; }
    if (act === 'play-cancel') { cancelPlay(); return; }
    if (act === 'play-confirm') {
      if (!playReady()) { toast('还没有满足出牌条件', true); return; }
      submitPlay();
      return;
    }
    if (act === 'resp-confirm') { submitResponse(); return; }
    if (act === 'resp-pass') { resolveAnswer(null); return; }
    if (act === 'pick-confirm') { confirmHandPick(); return; }
    if (act === 'pick-cancel') { cancelHandPick(); return; }
    if (act === 'resp-pick') {
      const req = pending && pending.req;
      if (!req) return;
      const variants = (req.options || []).filter(function (o) { return o.cardId === respCardId; });
      const o = variants[Number(btn.dataset.idx)];
      if (o) { respSel = o; render(game); }
    }
  }

  function handCardById(cid) {
    if (!game || !game.players) return null;
    const me = game.players[humanSeat];
    return me && me.hand ? me.hand.find(function (c) { return c.id === cid; }) : null;
  }
  function onHandPressDown(e) {
    if (e.button != null && e.button !== 0) return;
    const el = e.target.closest ? e.target.closest('.hand-card') : null;
    if (!el) return;
    cancelHandPress();
    handPressInfo = { cid: Number(el.dataset.cid), x: e.clientX, y: e.clientY };
    handPressTimer = setTimeout(function () {
      handPressTimer = 0;
      const info = handPressInfo;
      handPressInfo = null;
      if (!info) return;
      const card = handCardById(info.cid);
      if (!card) return;
      const target = document.querySelector('.hand-card[data-cid="' + info.cid + '"]') || el;
      suppressHandClickUntil = Date.now() + 900;
      showTip(cardTip(card), target);
    }, 550);
  }
  function onHandPressMove(e) {
    if (!handPressInfo) return;
    if (Math.abs(e.clientX - handPressInfo.x) > 8 || Math.abs(e.clientY - handPressInfo.y) > 8) cancelHandPress();
  }
  function cancelHandPress() {
    if (handPressTimer) { clearTimeout(handPressTimer); handPressTimer = 0; }
    handPressInfo = null;
  }
  function onHandPressEnd() { cancelHandPress(); }
  function onHandContextMenu(e) {
    const el = e.target.closest ? e.target.closest('.hand-card') : null;
    if (!el) return;
    e.preventDefault();
    cancelHandPress();
    const card = handCardById(Number(el.dataset.cid));
    if (card) showTip(cardTip(card), el);
  }

  function onHandClick(e) {
    if (Date.now() < suppressHandClickUntil) { e.preventDefault(); e.stopPropagation(); return; }
    const cardEl = e.target.closest ? e.target.closest('.hand-card') : null;
    if (!cardEl) return;
    const cid = Number(cardEl.dataset.cid);
    const req = pending && pending.req;
    if (!req) return;
    // 视觉已选中的牌再次点击：无论 action 结构如何都取消
    if (cardEl.classList.contains('is-selected')) {
      if (req.type === 'play') { cancelPlay(); return; }
      if (req.type === 'response') { respSel = null; respCardId = null; render(game); return; }
      if (req.type === 'chooseCards' && handPickMode(req)) {
        const st0 = handPickState();
        if (st0) { const i0 = st0.selected.indexOf(cid); if (i0 >= 0) st0.selected.splice(i0, 1); }
        render(game); return;
      }
    }

    if (req.type === 'chooseCards' && handPickMode(req)) {
      const st = handPickState();
      if (!st || !(req.cards || []).some(function (c) { return c.id === cid; })) return;
      const i = st.selected.indexOf(cid);
      if (i >= 0) st.selected.splice(i, 1);
      else {
        const max = req.max == null ? (req.cards || []).length : req.max;
        if (st.selected.length >= max) { toast('最多选择 ' + max + ' 张牌', true); return; }
        st.selected.push(cid);
      }
      render(game);
      return;
    }

    if (req.type === 'response') {
      const variants = (req.options || []).filter(function (o) { return o.cardId === cid; });
      if (!variants.length) { toast('这张牌不能用于本次响应'); return; }
      if (variants.length === 1 && respSel && respSel.cardId === cid) {
        respSel = null; respCardId = null;
      } else {
        respSel = variants[0];
        respCardId = cid;
      }
      render(game);
      return;
    }

    if (req.type === 'play') {
      if (sel.action && sel.action.kind === 'skill' && sel.action.needsCards) {
        toggleSkillCard(cid);
        return;
      }
      const tmpls = (req.actions || []).filter(function (a) {
        return a.kind === 'card' && (a.subcards || []).indexOf(cid) >= 0;
      });
      if (!tmpls.length) {
        toast('这张牌现在不能使用');
        return;
      }
      if (sel.action && sel.action.kind === 'card' && (sel.action.subcards || []).indexOf(cid) >= 0) {
        cancelPlay();
        return;
      }
      if (tmpls.length === 1) {
        if (sel.action === tmpls[0]) { cancelPlay(); return; }
        selectPlayAction(tmpls[0]);
        return;
      }
      chooser = { cid: cid, options: tmpls };
      renderChooser();
      return;
    }
  }

  function toggleSkillCard(cid) {
    const t = sel.action;
    if (!t || !t.needsCards) return;
    const idx = sel.cards.indexOf(cid);
    if (idx >= 0) { sel.cards.splice(idx, 1); render(game); return; }
    if (sel.cards.length >= t.needsCards.max) { toast('最多选择 ' + t.needsCards.max + ' 张牌', true); return; }
    if (t.sameSuit && sel.cards.length) {
      const g = game;
      const me = g.players[humanSeat];
      const first = me.hand.find(function (c) { return c.id === sel.cards[0]; });
      const card = me.hand.find(function (c) { return c.id === cid; });
      if (first && card && first.suit !== card.suit) { toast('需要选择相同花色的牌', true); return; }
    }
    sel.cards.push(cid);
    render(game);
  }

  function selectPlayAction(t) {
    sel.action = t;
    sel.cards = (t.kind === 'card' && t.subcards) ? t.subcards.slice() : [];
    sel.targets = [];
    chooser = null;
    closeChooser();
    render(game);
  }

  function cancelPlay() {
    sel.action = null; sel.cards = []; sel.targets = [];
    chooser = null; closeChooser();
    render(game);
  }

  function playReady() {
    const t = sel.action;
    if (!t) return false;
    const need = t.needsCards;
    if (need) {
      if (sel.cards.length < need.min || sel.cards.length > need.max) return false;
      if (t.sameSuit && sel.cards.length > 1) {
        const me = game.players[humanSeat];
        const suits = sel.cards.map(function (id) {
          const c = me.hand.find(function (x) { return x.id === id; });
          return c ? c.suit : null;
        });
        if (suits.some(function (s) { return s !== suits[0]; })) return false;
      }
    } else if (t.kind === 'card') {
      if (!t.subcards || !t.subcards.length) return false;
      if (sel.cards.length !== t.subcards.length) return false;
    }
    const min = t.minTargets || 0;
    const max = t.maxTargets || 0;
    if (sel.targets.length < min || sel.targets.length > max) return false;
    return true;
  }

  function submitPlay() {
    const t = sel.action;
    if (!t) return;
    let ans;
    if (t.kind === 'card') {
      ans = { kind: 'card', subcards: sel.cards.slice(), as: t.as, skill: t.skill || null, targets: sel.targets.slice() };
    } else {
      ans = { kind: 'skill', skill: t.skill, cards: sel.cards.slice(), targets: sel.targets.slice() };
    }
    // 借刀确认后短暂保留两段指向：人类→持武器者、持武器者→被杀者
    if (t.kind === 'card' && t.as === 'jiedao' && t.secondStage === 'jiedao' && sel.targets.length === 2) {
      const now = Date.now();
      transientAim = transientAim.filter(function (a) { return a.until > now; });
      transientAim.push({ from: humanSeat, to: sel.targets[0], until: now + 1500 });
      transientAim.push({ from: sel.targets[0], to: sel.targets[1], until: now + 1500 });
      drawAim();
      if (flashAimTimer) clearTimeout(flashAimTimer);
      flashAimTimer = setTimeout(function () { flashAimTimer = 0; drawAim(); }, 1550);
    }
    resolveAnswer(ans);
  }

  function submitResponse() {
    if (!respSel) { toast('请先选择一张牌'); return; }
    resolveAnswer({ cardId: respSel.cardId, as: respSel.as, skill: respSel.skill || null });
  }

  function onSkillClick(e) {
    const btn = e.target.closest ? e.target.closest('[data-skill]') : null;
    if (!btn) return;
    const id = btn.dataset.skill;
    const req = pending && pending.req;
    if (!req || req.type !== 'play') { toast('现在不是你的出牌阶段'); return; }
    const t = (req.actions || []).find(function (a) { return a.kind === 'skill' && a.skill === id; });
    if (!t) { toast('【' + skillName(id) + '】现在无法发动'); return; }
    selectPlayAction(t);
  }

  function onEquipClick(e) {
    const slot = e.target.closest ? e.target.closest('[data-slot]') : null;
    if (!slot) return;
    const me = game && game.players[humanSeat];
    const card = me && me.equips && me.equips[slot.dataset.slot];
    if (card) toast(cardDef(card.name).name + '：' + cardDef(card.name).desc);
  }

  function onSeatsClick(e) {
    const eq = e.target.closest ? e.target.closest('.eq-bar') : null;
    if (eq && !sel.action && !tablePick) {
      e.preventDefault();
      e.stopPropagation();
      const tip = eq.getAttribute('data-tip') || '';
      if (tip) showTip(tip, eq);
      return;
    }
    const seatEl = e.target.closest ? e.target.closest('.seat') : null;
    if (!seatEl) return;
    onSeatPick(Number(seatEl.dataset.seat));
  }

  function onSeatPick(seat) {
    if (tablePick) {
      const req = tablePick.req;
      const cands = (req.candidates || []).filter(function (s) { return game.players[s] && game.players[s].alive; });
      if (cands.indexOf(seat) < 0) return;
      const i = tablePick.selected.indexOf(seat);
      if (i >= 0) tablePick.selected.splice(i, 1);
      else {
        const max = req.max == null ? cands.length : req.max;
        if (tablePick.selected.length >= max) tablePick.selected.shift();
        tablePick.selected.push(seat);
      }
      render(game);
      return;
    }
    const req = pending && pending.req;
    if (!req || req.type !== 'play') return;
    if (!sel.action) { toast('请先选择一张牌或技能，再点击目标'); return; }
    const t = sel.action;
    if (!actionHasTargets(t)) { toast('这张牌/技能不需要指定目标'); return; }
    const idx = sel.targets.indexOf(seat);
    if (idx >= 0) {
      sel.targets.splice(idx, 1);
      render(game);
      return;
    }
    const cands = targetCandidates();
    if (cands.indexOf(seat) < 0) {
      const info = targetRejectInfo(seat);
      toast(info.text || '无法指定该角色为目标', true);
      hoverSeat = seat;
      drawAim();
      return;
    }
    const max = t.maxTargets || 0;
    if (max <= 0) return;
    if (sel.targets.length >= max) sel.targets.pop();
    sel.targets.push(seat);
    render(game);
  }

  /* ---------- 手牌使用方式选择 ---------- */
  function renderChooser() {
    if (!chooser || !els.chooser) return;
    const me = game.players[humanSeat];
    const card = (me.hand || []).find(function (c) { return c.id === chooser.cid; });
    const head = '<div class="cc-head">' + (card ? esc(cardDef(card.name).name) : '') + ' · 选择使用方式</div>';
    const opts = chooser.options.map(function (t, i) {
      return '<button class="cc-opt" data-cc="' + i + '"><span class="cc-as">' + (t.as ? esc(cardDef(t.as).name) : '技能') + '</span>' +
        esc(t.label || '使用') + '</button>';
    }).join('');
    els.chooser.innerHTML = head + opts;
    els.chooser.classList.add('is-open');
  }
  function onChooserClick(e) {
    const btn = e.target.closest ? e.target.closest('[data-cc]') : null;
    if (!btn || !chooser) return;
    const t = chooser.options[Number(btn.dataset.cc)];
    if (t) selectPlayAction(t);
  }
  function closeChooser() {
    chooser = null;
    if (els.chooser) {
      els.chooser.classList.remove('is-open');
      els.chooser.innerHTML = '';
    }
  }
  function hideChooser() { closeChooser(); }

  /* ---------- 中央出牌 / 阶段 ---------- */
  function renderCenter(g) {
    const phase = PHASE_CN[g.phase] || '准备';
    if (els.orbitPhase.textContent !== phase) els.orbitPhase.textContent = phase;
    const cur = g.players && g.players[g.currentSeat];
    const sub = cur ? (cur.isHuman ? '你的回合' : displayName(cur)) : '';
    if (els.orbitSub.textContent !== sub) els.orbitSub.textContent = sub;

    const table = g.table || [];
    const sig = table.map(function (c) { return c.id; }).join(',') + '|' + table.length;
    if (sig !== last.tableSig) {
      last.tableSig = sig;
      if (!table.length) {
        els.played.innerHTML = '';
      } else {
        els.played.innerHTML = table.slice(-3).map(function (c) {
          const def = cardDef(c.name);
          const tag = c.skill ? skillName(c.skill) : (c.virtual ? '转化' : '');
          return '<div class="played-card" data-tip="' + esc(cardTip(c)) + '">' +
            cardImgTag(c) +
            cardCornersHTML(c) +
            (tag ? '<span class="pc-tag">' + esc(tag) + '</span>' : '') +
            '<span class="pc-name">' + esc(def.name) + '</span></div>';
        }).join('');
        // 出牌音效统一由 recent use 事件驱动（覆盖 AI/装备/锦囊）
      }
    }
  }

  function renderPickBar() {
    if (!els.pickBar) return;
    if (!tablePick) { if (els.pickBar.innerHTML) els.pickBar.innerHTML = ''; return; }
    const req = tablePick.req;
    const min = req.min || 0;
    const max = req.max == null ? (req.candidates || []).length : req.max;
    const n = tablePick.selected.length;
    els.pickBar.innerHTML = '<div class="pick-bar-inner">' +
      '<span class="pick-bar-text">' + esc(req.reason || '选择目标') + '</span>' +
      '<b class="pick-bar-count">' + n + ' / ' + max + '</b>' +
      '<button class="btn btn-ghost" data-pick="cancel">取消</button>' +
      '<button class="btn btn-primary" data-pick="ok"' + (n < min ? ' disabled' : '') + '>确认</button>' +
      '</div>';
  }

  function onPickBarClick(e) {
    if (!tablePick) return;
    const btn = e.target.closest ? e.target.closest('[data-pick]') : null;
    if (!btn) return;
    if (btn.dataset.pick === 'cancel') resolveAnswer(null);
    else if (btn.dataset.pick === 'ok') resolveAnswer(tablePick.selected.slice());
  }

  /* ---------- 战报 ---------- */
  function audioApi() {
    try { return global.SGS_AUDIO || null; } catch (e) { return null; }
  }

  function setSettings(open) {
    if (!els.settingsPanel) return;
    settingsOpen = !!open;
    els.settingsPanel.classList.toggle('is-open', settingsOpen);
    if (els.btnSettings) els.btnSettings.classList.toggle('is-on', settingsOpen);
    if (settingsOpen) {
      if (logOpen) {
        logOpen = false;
        if (els.logPanel) els.logPanel.classList.remove('is-open');
      }
      syncSettings();
    }
  }

  function syncSettings() {
    if (!els.setBgm) return;
    const A = audioApi();
    let bgm = 35;
    let sfx = 100;
    try {
      if (A && typeof A.bgmVolume === 'number') bgm = Math.round(A.bgmVolume * 100);
      if (A && typeof A.volume === 'number') sfx = Math.round(A.volume * 100);
    } catch (e) { /* ignore */ }
    els.setBgm.value = bgm;
    els.setSfx.value = sfx;
    if (els.setBgmVal) els.setBgmVal.textContent = bgm + '%';
    if (els.setSfxVal) els.setSfxVal.textContent = sfx + '%';
    if (els.setAnim) els.setAnim.checked = !document.body.classList.contains('reduce-motion');
    const pace = (hooks.getPace && hooks.getPace()) || 'normal';
    if (els.setPace) {
      Array.prototype.forEach.call(els.setPace.querySelectorAll('[data-pace]'), function (b) {
        b.classList.toggle('is-on', b.dataset.pace === pace);
      });
    }
  }

  function onBgmVolume(e) {
    const v = Number(e.target.value) || 0;
    if (els.setBgmVal) els.setBgmVal.textContent = v + '%';
    const A = audioApi();
    try { if (A) A.bgmVolume = v / 100; } catch (err) { /* ignore */ }
    saveSettings({ bgm: v });
  }

  function onSfxVolume(e) {
    const v = Number(e.target.value) || 0;
    if (els.setSfxVal) els.setSfxVal.textContent = v + '%';
    const A = audioApi();
    try { if (A) A.volume = v / 100; } catch (err) { /* ignore */ }
    saveSettings({ sfx: v });
  }

  function onAnimToggle(e) {
    document.body.classList.toggle('reduce-motion', !e.target.checked);
    saveSettings({ anim: !!e.target.checked });
  }

  function onPacePick(e) {
    const btn = e.target.closest ? e.target.closest('[data-pace]') : null;
    if (!btn) return;
    const pace = btn.dataset.pace;
    if (hooks.onPaceChange) {
      try { hooks.onPaceChange(pace); } catch (err) { console.error(err); }
    }
    saveSettings({ pace: pace });
    syncSettings();
  }

  function setLog(open) {
    logOpen = !!open;
    if (logOpen) {
      settingsOpen = false;
      if (els.settingsPanel) els.settingsPanel.classList.remove('is-open');
      if (els.btnSettings) els.btnSettings.classList.remove('is-on');
    }
    if (els.logPanel) els.logPanel.classList.toggle('is-open', logOpen);
    if (logOpen) {
      if (els.logBody) els.logBody.scrollTop = els.logBody.scrollHeight;
      logNewCount = 0;
      showLogNew(0);
    }
  }

  function logNearBottom() {
    if (!els.logBody) return true;
    return els.logBody.scrollHeight - els.logBody.scrollTop - els.logBody.clientHeight < 42;
  }

  function onLogScroll() {
    if (logNearBottom()) { logNewCount = 0; showLogNew(0); }
  }

  function showLogNew(count) {
    if (!els.logNew) return;
    if (count > 0) {
      els.logNew.hidden = false;
      els.logNew.innerHTML = '↓ 新消息 <b>' + count + '</b>';
    } else {
      els.logNew.hidden = true;
    }
  }

  function renderLog(g) {
    if (!els.logBody) return;
    const logs = g.logs || [];
    let rebuild = false;
    if (last.logLen < 0) rebuild = true;
    else if (logs.length < last.logLen) rebuild = true;
    else if (logs.length === last.logLen && last.logTail && logs[last.logLen - 1] !== last.logTail) rebuild = true;
    if (rebuild) {
      els.logBody.innerHTML = '';
      last.logLen = 0;
      last.logTail = null;
    }
    if (logs.length > last.logLen) {
      const added = logs.length - last.logLen;
      const frag = document.createDocumentFragment();
      for (let i = last.logLen; i < logs.length; i++) {
        const entry = logs[i];
        const div = document.createElement('div');
        div.className = 'log-line t-' + (entry.type || 'info');
        div.innerHTML = '<span class="log-turn">#' + (entry.turn || 0) + '</span>' + esc(entry.text || '');
        frag.appendChild(div);
      }
      els.logBody.appendChild(frag);
      last.logLen = logs.length;
      last.logTail = logs[logs.length - 1] || null;
      while (els.logBody.children.length > 400) els.logBody.removeChild(els.logBody.firstChild);
      if (logOpen) {
        if (logNearBottom()) {
          els.logBody.scrollTop = els.logBody.scrollHeight;
          logNewCount = 0;
          showLogNew(0);
        } else {
          // 用户正在翻历史：保持当前滚动位置，只提示有新消息
          logNewCount += added;
          showLogNew(logNewCount);
        }
      } else {
        logNewCount = 0;
        showLogNew(0);
      }
    }
  }

  /* ============================================================
     选将
     ============================================================ */
  function renderSelect(g) {
    if (!pending || pending.req.type !== 'chooseGeneral') return;
    const req = pending.req;
    const me = g && g.players ? g.players[humanSeat] : null;
    if (els.selectRole) els.selectRole.textContent = (g && g.mode === '1v1') ? '单挑 · 1 号位' : ((g && g.mode === 'ddz') ? ('斗地主 · ' + (me && g.roleName ? g.roleName(me.role) : '—')) : ('身份：' + (me && g.roleName ? g.roleName(me.role) : '—')));
    if (els.selectReason) els.selectReason.textContent = req.reason || '请选择武将';
    const sig = (req.candidates || []).map(function (x) { return x.id; }).join(',');
    if (sig !== selectSig) {
      selectSig = sig;
      selectIdx = -1;
      renderGeneralCards(req, me);
    }
    updateSelectUI();
  }

  function renderGeneralCards(req, me) {
    const lord = me && (me.role === 'lord' || (game && game.mode === 'ddz' && me.role === 'landlord'));
    els.generalRow.innerHTML = (req.candidates || []).map(function (gen, i) {
      const totalHp = gen.hp + (lord ? 1 : 0);
      const skills = gen.skills || [];
      return '<button class="general-card" data-index="' + i + '" style="--k:' + kingdomColor(gen.kingdom) + '">' +
        '<div class="gc-art"><img src="' + bigImg(gen.id) + '" alt="" onerror="this.onerror=null;this.src=\'' + seatImg(gen.id) + '\'"></div>' +
        '<div class="gc-kingdom">' + esc(gen.kingdom) + '</div>' +
        '<div class="gc-hp" data-hp="' + totalHp + '/' + totalHp + '">' + beadsHTML(totalHp, totalHp, '') + '</div>' +
        '<div class="gc-picked-mark">已选择</div>' +
        '<div class="gc-body">' +
        '<div class="gc-name">' + esc(gen.name) + '<small>' + (gen.gender === 'female' ? '♀' : '♂') + '</small></div>' +
        '<div class="gc-title">' + esc(gen.title || '') + '</div>' +
        '<div class="gc-skills">' + skills.map(function (id) {
          const desc = skillDesc(id);
          const tip = skillName(id) + (desc ? '：' + desc : '');
          return '<span class="gc-skill" data-tip="' + esc(tip) + '">' + esc(skillName(id)) + '</span>';
        }).join('') +
        '<div class="gc-skill-descs">' + skills.map(function (id) {
          const desc = skillDesc(id) || '暂无描述';
          return '<p><b>' + esc(skillName(id)) + '</b><span>' + esc(desc) + '</span></p>';
        }).join('') + '</div></div>' +
        '</div>' +
        '<div class="gc-pack">' + esc(gen.pack || '') + ' · 体力 ' + totalHp + '</div>' +
        '</button>';
    }).join('');
  }

  function onGeneralClick(e) {
    const card = e.target.closest ? e.target.closest('.general-card') : null;
    if (!card || !pending || pending.req.type !== 'chooseGeneral') return;
    selectIdx = Number(card.dataset.index);
    updateSelectUI();
  }

  function updateSelectUI() {
    if (!els.generalRow) return;
    Array.prototype.forEach.call(els.generalRow.children, function (el) {
      el.classList.toggle('is-picked', Number(el.dataset.index) === selectIdx);
    });
    if (els.btnGeneralConfirm) els.btnGeneralConfirm.disabled = selectIdx < 0;
    if (els.selectHint) {
      const g = pending && pending.req && pending.req.candidates && pending.req.candidates[selectIdx];
      els.selectHint.innerHTML = g
        ? '已选择 <b>' + esc(g.name) + '</b> · ' + esc(g.kingdom) + ' · 体力 ' + (g.hp + ((game.players[humanSeat].role === 'lord' || (game.mode === 'ddz' && game.players[humanSeat].role === 'landlord')) ? 1 : 0))
        : '点击卡片选择武将，悬停技能名可查看描述';
    }
  }

  function onGeneralConfirm() {
    if (!pending || pending.req.type !== 'chooseGeneral' || selectIdx < 0) return;
    const idx = selectIdx;
    resolveAnswer({ index: idx });
  }

  /* ============================================================
     弹窗：十类请求
     ============================================================ */
  function resetModalState(req) {
    m = {
      cards: [], targets: [], choice: null, pick: null, hiddenPick: null,
      top: (req.type === 'arrange' ? (req.cards || []).slice() : []),
      bottom: [],
      assign: {}, activeCard: (req.type === 'distribute' && req.cards && req.cards[0]) ? req.cards[0].id : null,
    };
  }

  function renderModal(g) {
    if (confirmOpen) return;
    if (!els.modalRoot) return;
    const req = pending && pending.req;
    if (!req || req.type === 'play' || req.type === 'response' || req.type === 'chooseGeneral' || req.type === 'chooseTargets' || (req.type === 'chooseCards' && handPickMode(req))) {
      if (els.modalRoot.innerHTML !== '') els.modalRoot.innerHTML = '';
      els.modalRoot._lastHTML = '';
      modalReq = null;
      return;
    }
    if (modalReq !== req) { modalReq = req; resetModalState(req); last.modalHTML = ''; }
    if (!m) resetModalState(req);
    const html = modalHTML(req);
    if (html !== last.modalHTML || els.modalRoot.innerHTML !== html) {
      last.modalHTML = html;
      els.modalRoot.innerHTML = html;
      els.modalRoot._lastHTML = html;
    }
  }

  function modalFrame(req, title, body, foot, opts) {
    opts = opts || {};
    const refresh = !!last.modalHTML;
    return '<div class="modal-mask' + (refresh ? ' is-refresh' : '') + '"><div class="modal' + (opts.wide ? ' is-wide' : '') + '">' +
      '<div class="modal-head"><span class="modal-title">' + esc(title) + '</span>' +
      (opts.count ? '<span class="modal-count">' + opts.count + '</span>' : '') + '</div>' +
      '<div class="modal-reason">' + esc(req.reason || '') + '</div>' +
      '<div class="modal-body">' + body + '</div>' +
      '<div class="modal-foot">' + foot + '</div>' +
      '</div></div>';
  }

  function modalHTML(req) {
    switch (req.type) {
      case 'chooseCards': return modalChooseCards(req);
      case 'chooseTargets': return modalChooseTargets(req);
      case 'chooseOption': return modalChooseOption(req);
      case 'chooseCardFrom': return modalChooseCardFrom(req);
      case 'arrange': return modalArrange(req);
      case 'pickFrom': return modalPickFrom(req);
      case 'chooseHiddenCard': return modalChooseHiddenCard(req);
      case 'distribute': return modalDistribute(req);
      default: return modalFrame(req, TYPE_TITLE[req.type] || '请操作', '<div class="judge-empty">等待处理…</div>', '');
    }
  }

  function pickCardHTML(c, picked) {
    const def = cardDef(c.name);
    const s = suitOf(c);
    return '<button class="pick-card' + (picked ? ' is-picked' : '') + '" data-m="card" data-cid="' + c.id + '" data-tip="' + esc(cardTip(c)) + '">' +
      cardImgTag(c) +
      (s ? '<span class="pc-suit" style="color:' + suitColor(c) + '">' + s.cn + '</span>' : '') +
      '<span class="pc-rank">' + esc(rankCn(c.rank)) + '</span>' +
      '<span class="pc-name">' + esc(def.name) + '</span></button>';
  }

  function modalChooseCards(req) {
    const cards = req.cards || [];
    const min = req.min || 0;
    const max = req.max == null ? cards.length : req.max;
    const n = m.cards.length;
    const body = cards.length
      ? '<div class="cards-grid">' + cards.map(function (c) { return pickCardHTML(c, m.cards.indexOf(c.id) >= 0); }).join('') + '</div>'
      : '<div class="judge-empty">没有可选的牌</div>';
    const canConfirm = n >= min && n <= max;
    const foot = '<span class="modal-hint">' + (req.from === 'hand' ? '仅手牌' : '可选牌') + ' · 需要 ' + min + (max !== min ? '–' + max : '') + ' 张</span>' +
      '<button class="btn btn-ghost" data-m="cancel"' + (min > 0 ? ' disabled' : '') + '>' + (min > 0 ? '请选择' : '放弃') + '</button>' +
      '<button class="btn btn-primary" data-m="confirm"' + (canConfirm ? '' : ' disabled') + '>确认</button>';
    return modalFrame(req, '选择牌', body, foot, { count: '已选 <b>' + n + '</b> / ' + max });
  }

  function modalChooseTargets(req) {
    const cands = req.candidates || [];
    const min = req.min || 0;
    const max = req.max == null ? cands.length : req.max;
    const n = m.targets.length;
    const body = cands.length
      ? '<div class="seat-pick-grid">' + cands.map(function (s) { return seatPickHTML(s, m.targets.indexOf(s) >= 0); }).join('') + '</div>'
      : '<div class="judge-empty">没有可选目标</div>';
    const canConfirm = n >= min && n <= max;
    const foot = '<span class="modal-hint">需要选择 ' + min + (max !== min ? '–' + max : '') + ' 名角色</span>' +
      '<button class="btn btn-ghost" data-m="cancel"' + (min > 0 ? ' disabled' : '') + '>' + (min > 0 ? '请选择' : '放弃') + '</button>' +
      '<button class="btn btn-primary" data-m="confirm"' + (canConfirm ? '' : ' disabled') + '>确认</button>';
    return modalFrame(req, '选择目标', body, foot, { count: '已选 <b>' + n + '</b> / ' + max, wide: true });
  }

  function seatPickHTML(seat, picked) {
    const p = game.players[seat];
    const gen = p && p.general;
    const color = kingdomColor(p && (p.kingdom || (gen && gen.kingdom)));
    return '<button class="seat-pick' + (picked ? ' is-picked' : '') + (!p || !p.alive ? ' is-disabled' : '') + '" data-m="target" data-seat="' + seat + '">' +
      (gen ? '<img src="' + seatImg(gen.id) + '" alt="">' : '') +
      '<span class="sp-veil"></span>' +
      '<span class="sp-role">' + esc(roleLabelFor(game, p)) + '</span>' +
      '<span class="sp-name" style="color:' + color + '">' + esc(displayName(p)) + '</span>' +
      '<span class="sp-hp">' + Math.max(0, p.hp) + ' / ' + p.maxHp + '</span>' +
      '</button>';
  }

  function modalChooseOption(req) {
    const options = req.options || [];
    let body = '';
    if (/手气卡/.test(req.reason || '') && game && game.players && game.players[humanSeat]) {
      const hand = game.players[humanSeat].hand || [];
      body += '<div class="mul-preview">' + hand.map(function (c) {
        return '<span class="mul-card" data-tip="' + esc(cardTip(c)) + '">' + cardImgTag(c) +
          '<i class="mul-name">' + esc(cardDef(c.name).name) + '</i></span>';
      }).join('') + '</div>';
    }
    body += '<div class="option-grid">' + options.map(function (o) {
      return '<button class="option-btn" data-m="option" data-id="' + esc(o.id) + '">' + esc(o.label) + '</button>';
    }).join('') + '</div>';
    const reasonText = String(req.reason || '');
    const title = /抢地主/.test(reasonText) ? '抢地主' : (/叫地主/.test(reasonText) ? '叫地主' : '请选择');
    return modalFrame(req, title, body, '<span class="modal-hint">选择后立即生效</span>');
  }

  function modalChooseCardFrom(req) {
    const target = req.target;
    const choices = req.choices || [];
    const head = '<div class="zone-list">' + choices.map(function (ch, i) {
      const picked = m.choice && m.choice.key === choiceKey(ch);
      if (ch.zone === 'hand') {
        return '<button class="zone-item' + (picked ? ' is-picked' : '') + '" data-m="choice" data-idx="' + i + '">' +
          '<span class="zone-icon">牌</span><span class="zone-text"><span class="zone-name">手牌 ×' + ch.count + '</span>' +
          '<span class="zone-sub">随机获得其中一张</span></span></button>';
      }
      if (ch.zone === 'equip') {
        return '<button class="zone-item' + (picked ? ' is-picked' : '') + '" data-m="choice" data-idx="' + i + '">' +
          '<span class="zone-icon is-card"><img src="' + cardImgOf(ch.card) + '" alt=""></span>' +
          '<span class="zone-text"><span class="zone-name">' + esc(cardDef(ch.card.name).name) + '</span>' +
          '<span class="zone-sub">装备区 · ' + SLOT_CN[ch.slot] + '</span></span></button>';
      }
      return '<button class="zone-item' + (picked ? ' is-picked' : '') + '" data-m="choice" data-idx="' + i + '">' +
        '<span class="zone-icon is-card"><img src="' + cardImgOf(ch.card) + '" alt=""></span>' +
        '<span class="zone-text"><span class="zone-name">' + esc(cardDef(ch.card.name).name) + '</span>' +
        '<span class="zone-sub">判定区</span></span></button>';
    }).join('') + '</div>';
    const headInfo = '<div class="modal-target-head" style="margin-bottom:12px;font-size:12px;color:#a8a08e">目标：<b style="color:#f2dda6">' +
      esc(target ? displayName(target) : '—') + '</b> · 手牌 ' + (target ? target.hand.length : 0) + ' 张</div>';
    const foot = '<span class="modal-hint">选择一张牌' + (target ? '（手牌内容不可见）' : '') + '</span>' +
      '<button class="btn btn-ghost" data-m="cancel">取消</button>' +
      '<button class="btn btn-primary" data-m="confirm"' + (m.choice ? '' : ' disabled') + '>确认</button>';
    return modalFrame(req, '选择一张牌', headInfo + head, foot);
  }

  function choiceKey(ch) {
    if (ch.zone === 'hand') return 'hand';
    if (ch.zone === 'equip') return 'equip:' + ch.slot;
    return 'judge:' + (ch.card && ch.card.id);
  }

  function modalArrange(req) {
    const top = m.top || [];
    const bottom = m.bottom || [];
    function chips(list, zone) {
      return list.map(function (c, i) {
        return '<button class="arrange-chip" data-m="arr" data-zone="' + zone + '" data-cid="' + c.id + '">' +
          cardImgTag(c) +
          '<span class="ac-order">' + (i + 1) + '</span>' +
          '<span class="ac-name">' + esc(cardDef(c.name).name) + '</span></button>';
      }).join('');
    }
    const body = '<div class="arrange-wrap">' +
      '<div class="arrange-col"><div class="arrange-head">牌堆顶 <span>点击移到底部</span></div>' +
      '<div class="arrange-list">' + (top.length ? chips(top, 'top') : '<div class="arrange-empty">暂无牌 · 从右侧点击移入</div>') + '</div></div>' +
      '<div class="arrange-col"><div class="arrange-head">牌堆底 <span>点击移回顶部</span></div>' +
      '<div class="arrange-list">' + (bottom.length ? chips(bottom, 'bottom') : '<div class="arrange-empty">暂无牌</div>') + '</div></div>' +
      '</div>';
    const foot = '<span class="modal-hint">从上到下即为摸牌顺序 · 顶部 ' + top.length + ' 张 / 底部 ' + bottom.length + ' 张</span>' +
      '<button class="btn btn-ghost" data-m="arr-all-top">全部置顶</button>' +
      '<button class="btn btn-ghost" data-m="arr-all-bottom">全部置底</button>' +
      '<button class="btn btn-primary" data-m="confirm">确认</button>';
    return modalFrame(req, '调整牌序', body, foot, { wide: true });
  }

  function modalChooseHiddenCard(req) {
    const hr = q('hand-reveal');
    if (hr) hr.classList.remove('is-on', 'is-reveal');
    const n = Math.max(0, req.count || 0);
    const target = req.target;
    const body = '<div class="hidden-hand-head">目标 <b>' + esc(target ? displayName(target) : '对手') +
      '</b> · 手牌 <b>' + n + '</b> 张</div>' +
      '<div class="hidden-hand-row">' + Array.from({ length: n }, function (_, i) {
        return '<button class="hidden-card' + (m.hiddenPick === i ? ' is-picked' : '') + '" data-m="hidden" data-idx="' + i + '">' +
          '<span class="hc-back"><i>手牌</i></span><span class="hc-pos">' + (i + 1) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="hidden-hand-hint">牌面不可见，选择后展示该牌</div>';
    const foot = '<span class="modal-hint">' + (m.hiddenPick == null ? '请选择一张手牌' : '已选择第 ' + (m.hiddenPick + 1) + ' 张') + '</span>' +
      '<button class="btn btn-ghost" data-m="cancel">取消</button>' +
      '<button class="btn btn-primary" data-m="confirm"' + (m.hiddenPick == null ? ' disabled' : '') + '>确认选择</button>';
    return modalFrame(req, '选择手牌', body, foot, { wide: true });
  }

  function modalPickFrom(req) {
    const cards = req.cards || [];
    const body = '<div class="cards-grid">' + cards.map(function (c) { return pickCardHTML(c, m.pick === c.id); }).join('') + '</div>';
    const foot = '<span class="modal-hint">选择后立即获得</span>' +
      '<button class="btn btn-primary" data-m="confirm"' + (m.pick != null ? '' : ' disabled') + '>确认</button>';
    return modalFrame(req, '选择一张牌', body, foot);
  }

  function modalDistribute(req) {
    const cards = req.cards || [];
    const cands = (req.candidates || []).filter(function (s) { return game.players[s] && game.players[s].alive; });
    const assigned = Object.keys(m.assign).length;
    const cardsHTML = cards.map(function (c) {
      const seat = m.assign[c.id];
      const p = seat == null ? null : game.players[seat];
      return '<button class="dist-card' + (m.activeCard === c.id ? ' is-active' : '') + '" data-m="dist-card" data-cid="' + c.id + '">' +
        '<span class="dist-thumb">' + cardImgTag(c) + '</span>' +
        '<span class="dist-name">' + esc(cardDef(c.name).name) + '</span>' +
        '<span class="dist-assign' + (p ? '' : ' is-none') + '">' + (p ? '→ ' + esc(displayName(p)) : '未分配') + '</span></button>';
    }).join('');
    const seatsHTML = cands.map(function (s) {
      const p = game.players[s];
      const gen = p.general;
      return '<button class="dist-seat" data-m="dist-seat" data-seat="' + s + '">' +
        (gen ? '<img src="' + seatImg(gen.id) + '" alt="">' : '') +
        '<span class="ds-name">' + esc(displayName(p)) + '</span></button>';
    }).join('');
    const body = '<div class="dist-wrap"><div class="dist-cards">' + cardsHTML + '</div>' +
      '<div><div class="mini-title" style="margin-bottom:6px">分配给</div><div class="dist-seats">' + seatsHTML + '</div>' +
      '<div class="dist-tools"><button class="btn btn-ghost" data-m="dist-self">剩余全给自己</button></div></div></div>';
    const canConfirm = assigned === cards.length;
    const foot = '<span class="modal-hint">已分配 ' + assigned + ' / ' + cards.length + ' 张</span>' +
      '<button class="btn btn-primary" data-m="confirm"' + (canConfirm ? '' : ' disabled') + '>确认</button>';
    return modalFrame(req, '分配手牌', body, foot, { wide: true });
  }

  /* ---------- 弹窗交互 ---------- */
  function onModalClick(e) {
    if (fatalError) {
      if (e.target.closest && e.target.closest('[data-m="close-error"]')) {
        fatalError = null; lastFatalHTML = '';
        els.modalRoot.innerHTML = ''; els.modalRoot._lastHTML = '';
        if (game) render(game);
      }
      return;
    }
    const btn = e.target.closest ? e.target.closest('[data-m]') : null;
    if (!btn || !pending) return;
    const req = pending.req;
    const act = btn.dataset.m;

    if (act === 'card') {
      if (req.type === 'chooseCards') {
        const cid = Number(btn.dataset.cid);
        const i = m.cards.indexOf(cid);
        if (i >= 0) m.cards.splice(i, 1);
        else {
          const max = req.max == null ? (req.cards || []).length : req.max;
          if (m.cards.length >= max) m.cards.shift();
          m.cards.push(cid);
        }
        render(game);
      } else if (req.type === 'pickFrom') {
        m.pick = Number(btn.dataset.cid);
        render(game);
      }
      return;
    }
    if (act === 'hidden') {
      if (req.type !== 'chooseHiddenCard') return;
      m.hiddenPick = Number(btn.dataset.idx);
      render(game);
      return;
    }
    if (act === 'target') {
      if (req.type !== 'chooseTargets') return;
      const seat = Number(btn.dataset.seat);
      const i = m.targets.indexOf(seat);
      if (i >= 0) m.targets.splice(i, 1);
      else {
        const max = req.max == null ? (req.candidates || []).length : req.max;
        if (m.targets.length >= max) m.targets.shift();
        m.targets.push(seat);
      }
      render(game);
      return;
    }
    if (act === 'option') {
      if (req.type === 'chooseOption') resolveAnswer(btn.dataset.id);
      return;
    }
    if (act === 'choice') {
      const idx = Number(btn.dataset.idx);
      const ch = (req.choices || [])[idx];
      if (!ch) return;
      m.choice = Object.assign({ key: choiceKey(ch) }, ch);
      render(game);
      return;
    }
    if (act === 'arr') {
      const cid = Number(btn.dataset.cid);
      const zone = btn.dataset.zone;
      const from = zone === 'top' ? m.top : m.bottom;
      const to = zone === 'top' ? m.bottom : m.top;
      const i = from.findIndex(function (c) { return c.id === cid; });
      if (i < 0) return;
      const card = from.splice(i, 1)[0];
      to.push(card);
      render(game);
      return;
    }
    if (act === 'arr-all-top') {
      m.top = m.top.concat(m.bottom); m.bottom = []; render(game); return;
    }
    if (act === 'arr-all-bottom') {
      m.bottom = m.bottom.concat(m.top); m.top = []; render(game); return;
    }
    if (act === 'dist-card') {
      m.activeCard = Number(btn.dataset.cid);
      render(game);
      return;
    }
    if (act === 'dist-seat') {
      const seat = Number(btn.dataset.seat);
      let cid = m.activeCard;
      if (cid == null) {
        const un = (req.cards || []).find(function (c) { return m.assign[c.id] == null; });
        if (un) cid = un.id;
      }
      if (cid == null) return;
      m.assign[cid] = seat;
      const next = (req.cards || []).find(function (c) { return m.assign[c.id] == null; });
      m.activeCard = next ? next.id : null;
      render(game);
      return;
    }
    if (act === 'dist-self') {
      (req.cards || []).forEach(function (c) { if (m.assign[c.id] == null) m.assign[c.id] = humanSeat; });
      m.activeCard = null;
      render(game);
      return;
    }
    if (act === 'confirm') { modalConfirm(); return; }
    if (act === 'cancel') { modalCancel(); return; }
  }

  function modalConfirm() {
    if (!pending || !m) return;
    const req = pending.req;
    if (req.type === 'chooseCards') {
      const min = req.min || 0, max = req.max == null ? (req.cards || []).length : req.max;
      if (m.cards.length < min || m.cards.length > max) return;
      resolveAnswer(m.cards.slice());
      return;
    }
    if (req.type === 'chooseTargets') {
      const min = req.min || 0, max = req.max == null ? (req.candidates || []).length : req.max;
      if (m.targets.length < min || m.targets.length > max) return;
      resolveAnswer(m.targets.slice());
      return;
    }
    if (req.type === 'chooseCardFrom') {
      if (!m.choice) return;
      if (m.choice.zone === 'hand') resolveAnswer({ zone: 'hand' });
      else if (m.choice.zone === 'equip') resolveAnswer({ zone: 'equip', slot: m.choice.slot });
      else resolveAnswer({ zone: 'judge', cardId: m.choice.card.id });
      return;
    }
    if (req.type === 'arrange') {
      resolveAnswer({ top: m.top.slice(), bottom: m.bottom.slice() });
      return;
    }
    if (req.type === 'pickFrom') {
      if (m.pick == null) return;
      resolveAnswer(m.pick);
      return;
    }
    if (req.type === 'chooseHiddenCard') {
      if (m.hiddenPick == null) return;
      resolveAnswer(m.hiddenPick);
      return;
    }
    if (req.type === 'distribute') {
      const cards = req.cards || [];
      if (cards.some(function (c) { return m.assign[c.id] == null; })) return;
      resolveAnswer(cards.map(function (c) { return { cardId: c.id, seat: m.assign[c.id] }; }));
    }
  }

  function modalCancel() {
    if (!pending || !m) return;
    const req = pending.req;
    if (req.type === 'chooseCards') {
      if ((req.min || 0) > 0) return;
      resolveAnswer([]);
      return;
    }
    if (req.type === 'chooseTargets') {
      if ((req.min || 0) > 0) return;
      resolveAnswer([]);
      return;
    }
    if (req.type === 'chooseCardFrom') { resolveAnswer(null); return; }
    if (req.type === 'arrange') { resolveAnswer({ top: (req.cards || []).slice(), bottom: [] }); return; }
    if (req.type === 'pickFrom') { resolveAnswer(null); return; }
    if (req.type === 'chooseHiddenCard') { resolveAnswer(null); return; }
    if (req.type === 'distribute') { resolveAnswer([]); return; }
  }

  function renderFatal() {
    if (!els.modalRoot) return;
    const err = fatalError;
    const msg = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
    const html = '<div class="modal-mask"><div class="modal">' +
      '<div class="modal-head"><span class="modal-title">运行出错</span></div>' +
      '<div class="modal-reason">界面已停止渲染，请将下面的信息反馈给开发者</div>' +
      '<div class="modal-body"><pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.6;color:#e6a29a;margin:0">' + esc(msg) + '</pre></div>' +
      '<div class="modal-foot"><button class="btn btn-outline" data-m="close-error">关闭</button></div>' +
      '</div></div>';
    if (html !== lastFatalHTML) {
      lastFatalHTML = html;
      els.modalRoot.innerHTML = html;
      els.modalRoot._lastHTML = html;
    }
  }

  /* ============================================================
     特效
     ============================================================ */
  function seatAnchor(seat) {
    if (seat === humanSeat) return els.mePortrait;
    const root = seatEls.get(seat);
    return root || null;
  }

  function floatAt(seat, text, cls) {
    const target = seatAnchor(seat);
    if (!target || !els.fx) return;
    const r = target.getBoundingClientRect();
    const lr = els.fx.getBoundingClientRect();
    const node = document.createElement('div');
    node.className = 'fx-float ' + (cls || '');
    node.textContent = text;
    node.style.left = (r.left - lr.left + r.width / 2) + 'px';
    node.style.top = (r.top - lr.top + r.height * 0.42) + 'px';
    els.fx.appendChild(node);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 1200);
  }

  function ringAt(seat, color) {
    const target = seatAnchor(seat);
    if (!target || !els.fx) return;
    const r = target.getBoundingClientRect();
    const lr = els.fx.getBoundingClientRect();
    const node = document.createElement('div');
    node.className = 'fx-ring';
    node.style.left = (r.left - lr.left + r.width / 2) + 'px';
    node.style.top = (r.top - lr.top + r.height * 0.5) + 'px';
    if (color) node.style.borderColor = color;
    els.fx.appendChild(node);
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 650);
  }

  function markWuxieSeat(seat, cls) {
    const el = seatAnchor(seat);
    if (!el) return;
    el.classList.add(cls);
    setTimeout(function () { el.classList.remove(cls); }, 1200);
  }

  function flashSeat(seat) {
    const target = seatAnchor(seat);
    if (!target) return;
    target.classList.add(seat === humanSeat ? 'is-hit' : 'seat-hit');
    setTimeout(function () {
      target.classList.remove('is-hit');
      target.classList.remove('seat-hit');
    }, 470);
  }

  function chainFx(seats) {
    if (!els.chain || !game) return;
    els.chain.innerHTML = '';
    const list = (seats || []).filter(function (s) { return game.players[s]; });
    if (!list.length) return;
    const cr = els.chain.getBoundingClientRect();
    const anchors = list.map(function (s) {
      const el = aimAnchor(s);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { seat: s, x: r.left - cr.left + r.width / 2, y: r.top - cr.top + r.height * 0.42, w: r.width, h: r.height };
    }).filter(Boolean);
    anchors.forEach(function (a) {
      const arc = document.createElement('div');
      arc.className = 'chain-arc';
      arc.style.left = a.x + 'px';
      arc.style.top = a.y + 'px';
      arc.style.width = (a.w * 1.15) + 'px';
      arc.style.height = (a.h * 1.15) + 'px';
      els.chain.appendChild(arc);
    });
    if (anchors.length >= 2) {
      const a = anchors[0], b = anchors[1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const line = document.createElement('div');
      line.className = 'chain-line';
      line.style.left = ((a.x + b.x) / 2) + 'px';
      line.style.top = ((a.y + b.y) / 2) + 'px';
      line.style.width = dist + 'px';
      line.style.transform = 'translate(-50%,-50%) rotate(' + (Math.atan2(dy, dx) * 180 / Math.PI) + 'deg)';
      els.chain.appendChild(line);
    }
    clearTimeout(chainFx._t);
    chainFx._t = setTimeout(function () { if (els.chain) els.chain.innerHTML = ''; }, 1800);
  }

  function detectEffects(g) {
    if (!g.players || !g.players.length) return;
    if (effectsGame !== g) {
      effectsGame = g;
      last.recentLen = (g.recent || []).length;
      last.hp = {};
      g.players.forEach(function (p) { last.hp[p.seat] = p.hp; });
      const initLogs = g.logs || [];
      last.sfxLogLen = initLogs.length;
      last.sfxLogTail = initLogs.length ? initLogs[initLogs.length - 1] : null;
      last.judgeLogLen = initLogs.length;
      last.judgeLogTail = initLogs.length ? initLogs[initLogs.length - 1] : null;
      last.flowLogLen = initLogs.length;
      last.flowLogTail = initLogs.length ? initLogs[initLogs.length - 1] : null;
      return;
    }

    // 选将/发牌阶段只同步血量，不播受伤反馈（初始 4 血选到 3 血武将不是掉血）
    if (!g.started) {
      g.players.forEach(function (p) { last.hp[p.seat] = p.hp; });
      const preLogs = g.logs || [];
      last.sfxLogLen = preLogs.length;
      last.sfxLogTail = preLogs.length ? preLogs[preLogs.length - 1] : null;
      last.judgeLogLen = preLogs.length;
      last.judgeLogTail = preLogs.length ? preLogs[preLogs.length - 1] : null;
      last.flowLogLen = preLogs.length;
      last.flowLogTail = preLogs.length ? preLogs[preLogs.length - 1] : null;
      last.recentLen = (g.recent || []).length;
      return;
    }
    // HP 变化 → 飘字
    g.players.forEach(function (p) {
      const prev = last.hp[p.seat];
      if (prev != null && p.hp !== prev) {
        const diff = p.hp - prev;
        if (diff < 0) {
          floatAt(p.seat, '-' + (-diff), 'is-damage');
          ringAt(p.seat, 'rgba(255,92,72,.85)');
          const gen = p.general;
          // 开局 1.5s 内只同步血量/飘字，不播受伤语音，避免进入牌局误触发
          const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          if (gen && now >= (last.damageMuteUntil || 0)) sfx('playGeneral', gen.id, 'damage');
        } else if (diff > 0) {
          floatAt(p.seat, '+' + diff, 'is-heal');
        }
        last.hp[p.seat] = p.hp;
      }
    });

    // 技能语音：独立游标扫描新增战报（不与 last.logLen 混用）
    const logs = g.logs || [];
    if (last.sfxLogLen == null || logs.length < last.sfxLogLen) last.sfxLogLen = 0;
    else if (last.sfxLogTail) {
      const tailIdx = logs.lastIndexOf(last.sfxLogTail);
      last.sfxLogLen = tailIdx >= 0 ? tailIdx + 1 : 0;
    }
    for (let i = last.sfxLogLen; i < logs.length; i++) {
      const lg = logs[i];
      if (!lg || lg.type !== 'skill') continue;
      showSkillBanner(lg.text);
      const m = /【(.+?)】/.exec(lg.text || '');
      if (!m) continue;
      const skillName = m[1];
      // 同名技能可能有多个 id（如 luoshen / j_luoshen），必须按 owner 实际技能 id 选
      const nm = /^(.+?)\s*发动【/.exec(lg.text || '');
      const ownerName = nm ? nm[1].trim() : '';
      let owner = ownerName ? g.players.find(function (p) { return displayName(p) === ownerName; }) : null;
      if (!owner) {
        owner = g.players.find(function (p) {
          return p.alive && p.skills && p.skills.some(function (id) { return D.SKILLS[id] && D.SKILLS[id].name === skillName; });
        });
      }
      if (!owner || !owner.general) continue;
      const ownKey = (owner.skills || []).find(function (id) { return D.SKILLS[id] && D.SKILLS[id].name === skillName; });
      if (!ownKey) continue;
      sfx('playGeneral', owner.general.id, 'skill', ownKey);
    }
    last.sfxLogLen = logs.length;
    last.sfxLogTail = logs.length ? logs[logs.length - 1] : null;

    // 判定牌浮层：扫描新增的 judge 日志（引擎暂无 lastJudge 字段）
    const judgeLogs = g.logs || [];
    if (last.judgeLogLen == null || judgeLogs.length < last.judgeLogLen) last.judgeLogLen = 0;
    else if (last.judgeLogTail) {
      const jtailIdx = judgeLogs.lastIndexOf(last.judgeLogTail);
      last.judgeLogLen = jtailIdx >= 0 ? jtailIdx + 1 : 0;
    }
    for (let ji = last.judgeLogLen; ji < judgeLogs.length; ji++) {
      const jl = judgeLogs[ji];
      if (!jl || jl.type !== 'judge') continue;
      const info = parseJudgeLog(jl.text || '');
      if (info) queueJudge(info);
    }
    last.judgeLogLen = judgeLogs.length;
    last.judgeLogTail = judgeLogs.length ? judgeLogs[judgeLogs.length - 1] : null;
    if (judgeQueue.length && !judgeShowing) showNextJudge();

    // 通用卡牌流动效 / 五谷亮牌 / 响应亮牌
    const flowLogs = g.logs || [];
    if (last.flowLogLen == null || flowLogs.length < last.flowLogLen) last.flowLogLen = 0;
    else if (last.flowLogTail) {
      const ftailIdx = flowLogs.lastIndexOf(last.flowLogTail);
      last.flowLogLen = ftailIdx >= 0 ? ftailIdx + 1 : 0;
    }
    for (let fi = last.flowLogLen; fi < flowLogs.length; fi++) handleEffectLog(flowLogs[fi]);
    last.flowLogLen = flowLogs.length;
    last.flowLogTail = flowLogs.length ? flowLogs[flowLogs.length - 1] : null;
    updateWuguPicker(g);

    // recent 事件 → 闪红 / 阵亡提示
    const recent = g.recent || [];
    if (recent.length < last.recentLen) last.recentLen = 0;
    for (let i = last.recentLen; i < recent.length; i++) {
      const ev = recent[i];
      if (!ev) continue;
      if (ev.kind === 'pindian') { showPindian(ev); continue; }
      if (ev.kind === 'handReveal') { showHandReveal(ev); continue; }
      if (ev.kind === 'rescue') { showRescue(ev); continue; }
      if (ev.kind === 'use') {
        if (ev.card !== 'wuxie') sfx('playCard', ev.card, ev.gender || (g.players[ev.seat] && g.players[ev.seat].gender));
        if (ev.card !== 'wuxie') lastTrick = { card: ev.card, seat: ev.seat, targets: (ev.targets || []).slice() };
        if (ev.card === 'tiesuo') chainFx(ev.targets);
        else flashArrows(ev.seat, ev.targets || []);
      } else if (ev.kind === 'damage') {
        // 受伤语音由 HP 变化分支播武将语音；这里不再叠通用掉血声，避免“错牌/嘈杂”
        flashSeat(ev.seat);
      } else if (ev.kind === 'judge') {
        const c = ev.card || {};
        const su = SUITS[c.suit] || null;
        const cname = cardDef(c.name).name;
        const txt = (ev.who || '') + ' 判定（' + (ev.reason || '判定') + '）：【' + cname + '】' + (su ? su.cn : (c.suit || '')) + rankCn(c.rank);
        const info = parseJudgeLog(txt);
        if (info) queueJudge(info);
      } else if (ev.kind === 'death') {
        delete seatMarks[ev.seat];
        const p = g.players[ev.seat];
        const name = p ? displayName(p) : '角色';
        toast(name + ' 阵亡');
        const gen = p && p.general;
        if (gen) sfx('playGeneral', gen.id, 'death');
      }
    }
    last.recentLen = recent.length;
  }

  /* ============================================================
     结算
     ============================================================ */
  function showResult(g) {
    if (resultFor === g && screen === 'result') return;
    resultFor = g;
    hideTip();
    closeChooser();
    const human = g.players[humanSeat];
    const duel = g.mode === '1v1';
    const ddz = g.mode === 'ddz';
    const humanSide = human && (duel || ddz || g.teamMode ? human.role : (human.role === 'loyalist' ? 'lord' : human.role));
    let outcome = '对局结束';
    let duelWin = null;
    if (duel) {
      const alive = (g.players || []).filter(function (p) { return p.alive; });
      if (alive.length === 1) duelWin = alive[0].seat === humanSeat;
      else if (!alive.length) duelWin = false;
    }
    if (duel) {
      outcome = duelWin == null ? '平局' : (duelWin ? '胜利' : '失败');
    } else if (g.winner == null) {
      outcome = '平局';
    } else {
      outcome = humanSide === g.winner ? '胜利' : '失败';
    }
    if (els.resultPlayers) { els.resultPlayers.classList.toggle('is-duel', duel); els.resultPlayers.classList.toggle('is-ddz', ddz); }
    playSfxKey(outcome === '胜利' ? 'win' : outcome === '失败' ? 'lose' : 'draw');
    els.resultTitle.textContent = outcome;
    els.resultTitle.className = 'result-title' + (outcome === '胜利' ? ' is-win' : outcome === '失败' ? ' is-lose' : '');
    let mvpText = '';
    try {
      const dmg = (g.stats && g.stats.damage) || {};
      let bestSeat = null, best = 0;
      Object.keys(dmg).forEach(function (k) { const s2 = Number(k); if (dmg[k] > best) { best = dmg[k]; bestSeat = s2; } });
      if (bestSeat != null && best > 0 && g.players[bestSeat]) mvpText = ' · MVP：' + displayName(g.players[bestSeat]) + '（' + best + ' 点伤害）';
    } catch (e) { /* ignore */ }
    els.resultSub.textContent = (g.winText || '对局结束') + ' · 共 ' + (g.turnCount || 0) + ' 回合' + mvpText;

    const duelAlive = duel ? (g.players || []).find(function (p) { return p.alive; }) : null;
    const winnerRoles = duel ? (duelWin != null && duelAlive ? [duelAlive.role] : []) : (g.winner === 'lord' ? ['lord', 'loyalist'] : [g.winner]);
    els.resultPlayers.innerHTML = (g.players || []).map(function (p) {
      const gen = p.general;
      const win = winnerRoles.indexOf(p.role) >= 0;
      return '<div class="result-player' + (p.isHuman ? ' is-you' : '') + (!p.alive ? ' is-dead' : '') + (win ? ' is-winner' : '') + '">' +
        (gen ? '<img src="' + bigImg(gen.id) + '" alt="" onerror="this.onerror=null;this.src=\'' + seatImg(gen.id) + '\'">' : '') +
        '<div class="rp-veil"></div>' +
        '<span class="rp-role">' + esc(duel ? ((p.seat === 0 ? '1 号位' : '2 号位')) : g.roleName(p.role)) + '</span>' +
        '<span class="rp-name">' + esc(gen ? gen.name : displayName(p)) + '</span>' +
        '<span class="rp-info">' + (p.alive ? '存活' : '阵亡') + ' · ' + (gen ? gen.kingdom : '') + ' · ' + Math.max(0, p.hp) + '/' + p.maxHp + '</span>' +
        '</div>';
    }).join('');
    clearCountdown();
    clearJudgeOverlay();
    clearFlowFx();
    if (els.phaseBanner) els.phaseBanner.classList.remove('is-on');
    if (els.skillBanner) els.skillBanner.classList.remove('is-on');
    setLog(false);
    setSettings(false);
    showScreen('result');
  }

  /* ============================================================
     调试预览（截图用，不影响引擎）
     ============================================================ */
  function preview(kind) {
    if (!game || !game.players || !game.players.length) return;
    const me = game.players[humanSeat];
    const alive = game.alivePlayers || [];
    const others = alive.filter(function (p) { return p.seat !== humanSeat; });
    const hand = (me && me.hand) || [];
    let req = null;
    if (kind === 'response') {
      req = {
        type: 'response', player: me, need: 'shan',
        options: hand.slice(0, 3).map(function (c) { return { cardId: c.id, as: 'shan', skill: null }; }),
        reason: (others[0] ? displayName(others[0]) : '对手') + ' 对你使用了【杀】，是否使用【闪】？',
      };
    } else if (kind === 'chooseCards') {
      req = { type: 'chooseCards', player: me, cards: hand.slice(0, 5), min: 2, max: 2, reason: '弃牌阶段：请弃置 2 张手牌' };
    } else if (kind === 'chooseTargets') {
      req = { type: 'chooseTargets', player: me, candidates: alive.map(function (p) { return p.seat; }), min: 1, max: 2, reason: '请选择至多两名角色' };
    } else if (kind === 'chooseOption') {
      req = { type: 'chooseOption', player: me, options: [{ id: 'yes', label: '发动技能' }, { id: 'no', label: '放弃' }], reason: '是否发动技能？' };
    } else if (kind === 'chooseCardFrom') {
      const t = others[0] || me;
      const choices = [{ zone: 'hand', count: (t.hand || []).length }];
      SLOTS.forEach(function (slot) { if (t.equips && t.equips[slot]) choices.push({ zone: 'equip', slot: slot, card: t.equips[slot] }); });
      (t.judges || []).forEach(function (c) { choices.push({ zone: 'judge', card: c }); });
      req = { type: 'chooseCardFrom', player: me, target: t, choices: choices, reason: '过河拆桥：选择一张牌' };
    } else if (kind === 'arrange') {
      req = { type: 'arrange', player: me, cards: hand.slice(0, 4), reason: '【观星】：观看牌堆顶 4 张牌，决定置于牌堆顶或牌堆底' };
    } else if (kind === 'pickFrom') {
      req = { type: 'pickFrom', player: me, cards: hand.slice(0, 3), reason: '五谷丰登：选择一张牌获得' };
    } else if (kind === 'distribute') {
      req = { type: 'distribute', player: me, cards: hand.slice(0, 2), candidates: alive.map(function (p) { return p.seat; }), reason: '【遗计】摸两张牌并分配给任意角色' };
    }
    if (!req) return;
    pending = { req: req, resolve: function () {} };
    sel.action = null; sel.cards = []; sel.targets = [];
    respSel = null; respCardId = null;
    modalReq = null; m = null; last.actionHTML = ''; last.modalHTML = '';
    showScreen('game');
    render(game);
  }

  function confirmDialog(message, onOk, opts) {
    opts = opts || {};
    const root = els.modalRoot;
    if (!root) { if (global.confirm(message)) onOk(); return; }
    const okText = opts.okText || '确定';
    confirmOpen = true;
    root.innerHTML = '<div class="modal-mask"><div class="modal">' +
      '<div class="modal-head"><span class="modal-title">提示</span></div>' +
      '<div class="modal-reason">' + esc(message) + '</div>' +
      '<div class="modal-body"></div>' +
      '<div class="modal-foot"><button class="btn btn-outline" data-c="0">取消</button>' +
      '<button class="btn btn-primary" data-c="1">' + esc(okText) + '</button></div>' +
      '</div></div>';
    function close() {
      confirmOpen = false;
      root.innerHTML = '';
      last.modalHTML = '';
      if (game) { try { render(game); } catch (e) { /* ignore */ } }
    }
    const cancel = root.querySelector('[data-c="0"]');
    const ok = root.querySelector('[data-c="1"]');
    if (cancel) cancel.onclick = close;
    if (ok) ok.onclick = function () { close(); try { onOk(); } catch (e) { console.error(e); } };
  }

  function setTrust(on) {
    if (els.btnTrust) {
      els.btnTrust.textContent = on ? '取消托管' : '托管';
      els.btnTrust.classList.toggle('is-on', !!on);
    }
  }

  function surrender() {
    if (!game || game.over) return;
    if (pending && pending.req) resolveAnswer(defaultAnswer(pending.req));
    try { game.surrender(humanSeat); } catch (e) { console.error(e); }
  }

  /* ============================================================
     对外接口
     ============================================================ */
  global.SGS_UI = {
    init: init,
    bindGame: bindGame,
    request: request,
    freeze: freeze,
    render: render,
    showScreen: showScreen,
    showResult: showResult,
    showError: showError,
    surrender: surrender,
    setTrust: setTrust,
    confirmDialog: confirmDialog,
    answerPending: function (ans) { if (pending) resolveAnswer(ans); },
    preview: preview,
    toast: toast,
    isLogOpen: function () { return logOpen; },
    pauseCountdown: pauseCountdown,
    resumeCountdown: resumeCountdown,
    _layoutHand: layoutHand,
    _state: function () {
      return { game: game, pending: pending, sel: sel, screen: screen, lastAnswer: lastAnswer };
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
