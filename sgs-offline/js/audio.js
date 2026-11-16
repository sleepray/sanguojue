/* 三国杀 · 单机版 — 音频层
 * ------------------------------------------------------------------
 * 用法（在 index.html 里以普通 script 引入，需在游戏逻辑之后加载）：
 *
 *     <script src="js/audio.js"></script>
 *
 * 对外接口挂在 window.SGS_AUDIO：
 *
 *     SGS_AUDIO.playCard('sha')              // 打出一张牌的音效
 *     SGS_AUDIO.playCard('wuxie')
 *     SGS_AUDIO.playGeneral(1, 'skill')      // 武将技能语音
 *     SGS_AUDIO.playGeneral(1, 'damage')     // 受到伤害
 *     SGS_AUDIO.playGeneral(1, 'death')      // 阵亡
 *
 *     SGS_AUDIO.play('click')                // 内置界面音效（见下表）
 *     SGS_AUDIO.playBgm('battle')            // 'menu' | 'battle'
 *     SGS_AUDIO.stopBgm()
 *     SGS_AUDIO.enabled = false              // 总开关，关闭后一切播放变空操作
 *     SGS_AUDIO.volume = 0.7                 // 音效音量 0~1
 *     SGS_AUDIO.bgmVolume = 0.35             // 背景音乐音量 0~1
 *     SGS_AUDIO.unlock()                     // 首次用户交互后手动解锁（可选）
 *
 * 设计原则：
 *   1. 音频是纯增强，任何缺失（索引没加载到、文件 404、浏览器拒绝播放）都
 *      只做静默降级，绝不抛异常、绝不阻塞游戏流程。
 *   2. 索引 assets/audio_index.json 懒加载，只加载一次；加载失败时退化为
 *      按命名约定直接猜测文件路径，因此即使没有索引文件也能出声。
 *   3. 浏览器要求用户交互后才能出声，这里在首次点击/按键时自动解锁。
 * ------------------------------------------------------------------
 */
(function (global) {
  'use strict';

  var BASE = 'assets/audio/';          // 与 assets/audio_index.json 的 base 字段一致
  var INDEX_URL = 'assets/audio_index.json?v=4';
  var EXT = '.mp3';

  // 索引加载失败时的兜底路径表（与 tools/extract_audio.py 的命名保持一致）
  var FALLBACK_SFX = {
    click: 'sfx/sfx_click' + EXT,
    back: 'sfx/sfx_back' + EXT,
    card_play: 'sfx/sfx_card_play' + EXT,
    card_draw: 'sfx/sfx_card_draw' + EXT,
    card_flip: 'sfx/sfx_card_flip' + EXT,
    slash: 'sfx/sfx_slash' + EXT,
    kill: 'sfx/sfx_kill' + EXT,
    damage: 'sfx/sfx_damage' + EXT,
    armor: 'sfx/sfx_armor' + EXT,
    game_start: 'sfx/sfx_game_start' + EXT,
    turn_end: 'sfx/sfx_turn_end' + EXT,
    win: 'sfx/sfx_win' + EXT,
    lose: 'sfx/sfx_lose' + EXT,
    draw: 'sfx/sfx_draw' + EXT
  };
  var FALLBACK_BGM = {
    menu: 'bgm/bgm_menu' + EXT,
    battle: 'bgm/bgm_battle' + EXT
  };
  // 【杀】用挥砍声，其余牌用出牌声
  var SLASH_CARDS = { sha: 1, huosha: 1, leisha: 1 };

  var state = {
    index: null,        // 解析后的 audio_index.json
    loading: null,      // Promise，避免重复请求
    loadFailed: false,
    enabled: true,
    volume: 0.7,
    bgmVolume: 0.35,
    unlocked: false,
    pool: {},           // 路径 -> HTMLAudioElement，复用以避免反复建对象
    broken: {},         // 已确认播不出来的路径，不再重试
    bgmEl: null,
    bgmKey: null,
    pendingBgm: null,
    suspended: false
  };

  // ---------------------------------------------------------------- 内部工具

  function isBrowser() {
    return typeof global.document !== 'undefined' &&
           typeof global.Audio !== 'undefined';
  }

  function normalizeGeneralId(id) {
    if (id === null || id === undefined) return null;
    var s = String(id).replace(/[^0-9]/g, '');
    if (!s) return null;
    var n = parseInt(s, 10);
    if (!n || n < 1) return null;
    s = String(n);
    while (s.length < 3) s = '0' + s;
    return s;
  }

  function pickOne(list) {
    if (!list || !list.length) return null;
    if (list.length === 1) return list[0];
    return list[Math.floor(Math.random() * list.length)];
  }

  /** 把索引里的相对路径拼成可用 URL；已带协议或前导斜杠的原样返回。 */
  function toUrl(path) {
    if (!path) return null;
    if (/^(https?:|file:|data:|blob:|\/)/i.test(path)) return path;
    return BASE + path;
  }

  /**
   * 懒加载索引。返回 Promise，永不 reject：失败时 resolve(null)，
   * 调用方改用兜底命名约定继续工作。
   */
  function loadIndex() {
    if (state.index) return Promise.resolve(state.index);
    if (state.loading) return state.loading;
    // file:// / APK：优先使用内嵌 JS 索引，Chromium 的 fetch(file://) 会失败
    if (global.SGS_AUDIO_INDEX) {
      state.index = global.SGS_AUDIO_INDEX;
      if (state.index && state.index.base) BASE = state.index.base;
      return Promise.resolve(state.index);
    }
    if (state.loadFailed || typeof global.fetch !== 'function') {
      return Promise.resolve(null);
    }
    state.loading = global.fetch(INDEX_URL, { cache: 'no-store' })
      .then(function (resp) {
        if (!resp || !resp.ok) throw new Error('HTTP ' + (resp && resp.status));
        return resp.json();
      })
      .then(function (data) {
        state.index = data || null;
        if (state.index && state.index.base) BASE = state.index.base;
        return state.index;
      })
      .catch(function () {
        state.loadFailed = true;
        return null;
      })
      .then(function (res) {
        state.loading = null;
        return res;
      });
    return state.loading;
  }

  /** 有索引就直接回调，没有就等加载完再回调（最多等一次网络往返）。 */
  function withIndex(fn) {
    if (state.index || state.loadFailed) {
      try { fn(state.index); } catch (e) { /* 静默 */ }
      return;
    }
    loadIndex().then(function (idx) {
      try { fn(idx); } catch (e) { /* 静默 */ }
    }).catch(function () { /* 静默 */ });
  }

  function getAudio(path) {
    var url = toUrl(path);
    if (!url || state.broken[url]) return null;
    var el = state.pool[url];
    if (!el) {
      try {
        el = new global.Audio();
        el.preload = 'auto';
        el.src = url;
        el.addEventListener('error', function () {
          state.broken[url] = true;   // 文件不存在或解码失败：以后不再尝试
        });
        state.pool[url] = el;
      } catch (e) {
        state.broken[url] = true;
        return null;
      }
    }
    return el;
  }

  function warmPath(path) {
    var url = toUrl(path);
    if (!url || state.pool[url] || state.broken[url]) return;
    try {
      var el = new global.Audio();
      el.preload = 'auto';
      el.src = url;
      el.addEventListener('error', function () { state.broken[url] = true; });
      state.pool[url] = el;
      el.load();
    } catch (e) { /* 静默 */ }
  }

  /** 播放一条音效路径；任何异常都被吞掉。 */
  function playPath(path, opts) {
    if (!state.enabled || state.suspended || !isBrowser()) return;
    var el = getAudio(path);
    if (!el) return;
    opts = opts || {};
    try {
      el.volume = typeof opts.volume === 'number' ? opts.volume : state.volume;
      el.loop = !!opts.loop;
      if (opts.restart !== false) {
        try { el.currentTime = 0; } catch (e) { /* 尚未加载时忽略 */ }
      }
      var p = el.play();
      if (p && typeof p.catch === 'function') {
        p.catch(function () { /* 自动播放被拦截或文件缺失：静默 */ });
      }
    } catch (e) {
      /* 静默降级 */
    }
  }

  /** 从索引数组里挑一条播放，没有则用兜底路径。 */
  function playFromIndex(list, fallbackPath, opts) {
    var path = pickOne(list) || fallbackPath;
    if (path) playPath(path, opts);
  }

  function sfxPath(key) {
    if (state.index && state.index.sfx && state.index.sfx[key]) {
      return state.index.sfx[key];
    }
    return FALLBACK_SFX[key] || null;
  }

  // ---------------------------------------------------------------- 解锁播放

  function unlock() {
    if (state.unlocked) return;
    state.unlocked = true;
    // 用一条静音音频"占位"，让后续播放不再被浏览器拦截
    if (!isBrowser()) return;
    try {
      // 必须用真实可解码的音频做“用户手势解锁”，空 data URI 在 Chrome 会 NotSupportedError
      var probe = new global.Audio();
      probe.volume = 0;
      probe.src = toUrl(sfxPath('click') || 'sfx/sfx_click.mp3');
      var p = probe.play();
      if (p && typeof p.catch === 'function') p.catch(function () { /* 被拦截也不阻塞游戏 */ });
    } catch (e) { /* 静默 */ }
    if (state.pendingBgm) {
      var key = state.pendingBgm;
      state.pendingBgm = null;
      api.playBgm(key);
    }
  }

  function bindUnlock() {
    if (!isBrowser() || !global.addEventListener) return;
    var handler = function () { unlock(); };
    var opts = { once: true, passive: true };
    try {
      global.addEventListener('pointerdown', handler, opts);
      global.addEventListener('keydown', handler, opts);
      global.addEventListener('touchstart', handler, opts);
    } catch (e) { /* 静默 */ }
  }

  // ---------------------------------------------------------------- 对外接口

  var api = {
    /** @type {boolean} 总开关。关闭后所有播放调用变为空操作，背景音乐同时暂停。 */
    version: '1.0.0',

    playCard: function (name, gender) {
      if (!state.enabled || name === null || name === undefined) return;
      var key = String(name).toLowerCase();
      withIndex(function (idx) {
        var g = idx && idx.cardsGender ? idx.cardsGender[key] : null;
        var list = null;
        if (g) {
          if (gender === 'female') list = g.female;
          else if (gender === 'male') list = g.male;
          if (!list || !list.length) list = g.neutral;
        }
        if (!list || !list.length) list = idx && idx.cards ? idx.cards[key] : null;
        var fallback = idx && idx.cardFallback ? idx.cardFallback
          : (SLASH_CARDS[key] ? FALLBACK_SFX.slash : FALLBACK_SFX.card_play);
        if (list && list.length) {
          playFromIndex(list, fallback);
        } else if (idx && idx.cardFallback) {
          playPath(idx.cardFallback);
        } else {
          playPath(SLASH_CARDS[key] ? FALLBACK_SFX.slash : FALLBACK_SFX.card_play);
        }
      });
    },

    playGeneral: function (id, kind, skillKey) {
      if (!state.enabled) return;
      var gidPad = normalizeGeneralId(id);                 // '001'，用于拼文件名
      var gidKey = gidPad ? String(parseInt(gidPad, 10)) : null;  // '1'，用于查索引
      var k = (kind || 'skill').toLowerCase();
      withIndex(function (idx) {
        var g = null;
        if (idx && idx.generals && gidKey) {
          g = idx.generals[gidKey] || idx.generals[gidPad] || null;
        }
        // 技能级映射：只播本技能，缺该技能音则安静，绝不跨技能随机
        if (k === 'skill' && skillKey && idx && idx.generalSkills && gidKey) {
          var sm = idx.generalSkills[gidKey];
          var sl = sm && sm[skillKey];
          if (sl && sl.length) { playFromIndex(sl, null); return; }
          return;
        }
        if (k === 'damage') {
          // 素材包内没有"受伤"语音，统一用通用掉血音效
          if (g && g.damage && g.damage.length) {
            playFromIndex(g.damage, sfxPath('damage'));
          } else {
            playPath(sfxPath('damage') || FALLBACK_SFX.damage);
          }
          return;
        }
        var list = g && g[k];
        if (list && list.length) {
          playFromIndex(list, null);
          return;
        }
        // 该武将没有对应语音：不做"随便找一条别的武将声音"的事，保持安静
        if (!idx) {
          // 索引没加载到，按命名约定猜（general_001_skill1.mp3）
          var guess = 'general/general_' + gidPad + '_' +
            (k === 'death' ? 'death1' : 'skill1') + EXT;
          if (gidPad) playPath(guess);
        }
      });
    },

    /** 播放内置界面音效：click / back / card_play / card_draw / card_flip /
     *  slash / kill / damage / armor / game_start / turn_end / win / lose / draw */
    play: function (key) {
      if (!state.enabled || state.suspended) return;
      withIndex(function () {
        var path = sfxPath(key);
        if (path) playPath(path);
      });
    },

    playBgm: function (key) {
      if (!state.enabled) return;
      var name = key || 'menu';
      if (state.suspended) { state.pendingBgm = name; return; }
      if (!state.unlocked) { state.pendingBgm = name; return; }  // 等首次交互
      withIndex(function (idx) {
        var path = idx && idx.bgm && idx.bgm[name] ? idx.bgm[name]
          : FALLBACK_BGM[name];
        if (!path || state.broken[toUrl(path)]) return;
        var url = toUrl(path);
        if (state.bgmEl && state.bgmKey === url) {
          try {
            state.bgmEl.volume = state.bgmVolume;
            var p = state.bgmEl.play();
            if (p && typeof p.catch === 'function') p.catch(function () {});
          } catch (e) { /* 静默 */ }
          return;
        }
        api.stopBgm();
        try {
          var el = new global.Audio();
          el.src = url;
          el.loop = true;
          el.volume = state.bgmVolume;
          el.addEventListener('error', function () { state.broken[url] = true; });
          state.bgmEl = el;
          state.bgmKey = url;
          var pr = el.play();
          if (pr && typeof pr.catch === 'function') {
            pr.catch(function () { state.pendingBgm = name; });
          }
        } catch (e) { /* 静默 */ }
      });
    },

    suspend: function () {
      state.suspended = true;
      if (state.bgmEl) { try { state.bgmEl.pause(); } catch (e) { /* ignore */ } }
      Object.keys(state.pool || {}).forEach(function (k) {
        var el = state.pool[k];
        if (el) { try { el.pause(); } catch (e) { /* ignore */ } }
      });
      if (state.bgmEl) state.pendingBgm = state.bgmKey;
    },
    resume: function () {
      state.suspended = false;
      if (!state.enabled) return;
      if (state.bgmEl) {
        try {
          var p = state.bgmEl.play();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (e) { /* ignore */ }
      } else if (state.pendingBgm) {
        var k = state.pendingBgm;
        state.pendingBgm = null;
        api.playBgm(k);
      }
    },

    stopBgm: function () {
      if (state.bgmEl) {
        try {
          state.bgmEl.pause();
          state.bgmEl.currentTime = 0;
        } catch (e) { /* 静默 */ }
      }
      state.bgmEl = null;
      state.bgmKey = null;
      state.pendingBgm = null;
    },

    /** 预取索引并预热常用音效，可选的优化项，不调用也能正常工作。 */
    preload: function () {
      if (!isBrowser()) return Promise.resolve(null);
      bindUnlockOnce();
      return loadIndex().then(function (idx) {
        ['click', 'card_play', 'slash', 'damage'].forEach(function (k) {
          warmPath(sfxPath(k));
        });
        // 预加载所有卡牌语音（约 109 条 / 2MB），消除首次出牌的加载延迟
        if (idx && idx.cards) {
          Object.keys(idx.cards).forEach(function (k) {
            var list = idx.cards[k];
            if (Array.isArray(list)) list.forEach(warmPath);
          });
        }
        return idx;
      });
    },

    /** 预加载指定武将的技能/阵亡语音，减少首次触发延迟。 */
    preloadGenerals: function (ids) {
      if (!isBrowser() || !ids || !ids.length) return;
      loadIndex().then(function (idx) {
        if (!idx || !idx.generals) return;
        ids.forEach(function (id) {
          var g = idx.generals[String(id)] || idx.generals[String(Number(id))];
          if (!g) return;
          (g.skill || []).forEach(warmPath);
          (g.death || []).forEach(warmPath);
        });
      });
    },

    unlock: unlock
  };

  var unlockBound = false;
  function bindUnlockOnce() {
    if (unlockBound) return;
    unlockBound = true;
    bindUnlock();
  }

  // enabled / volume 用访问器实现，保证"关掉开关立刻停声"
  Object.defineProperty(api, 'enabled', {
    enumerable: true,
    get: function () { return state.enabled; },
    set: function (v) {
      state.enabled = !!v;
      if (!state.enabled) {
        if (state.bgmEl) {
          try { state.bgmEl.pause(); } catch (e) { /* 静默 */ }
        }
      } else if (state.enabled && !state.suspended && state.bgmKey && state.bgmEl) {
        try {
          var p = state.bgmEl.play();
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (e) { /* 静默 */ }
      }
    }
  });

  Object.defineProperty(api, 'volume', {
    enumerable: true,
    get: function () { return state.volume; },
    set: function (v) {
      var n = parseFloat(v);
      if (isFinite(n)) state.volume = Math.max(0, Math.min(1, n));
    }
  });

  Object.defineProperty(api, 'bgmVolume', {
    enumerable: true,
    get: function () { return state.bgmVolume; },
    set: function (v) {
      var n = parseFloat(v);
      if (!isFinite(n)) return;
      state.bgmVolume = Math.max(0, Math.min(1, n));
      if (state.bgmEl) {
        try { state.bgmEl.volume = state.bgmVolume; } catch (e) { /* 静默 */ }
      }
    }
  });

  // 首次交互自动解锁，并静默预取索引
  if (isBrowser()) {
    bindUnlockOnce();
    try { loadIndex(); } catch (e) { /* 静默 */ }
    // 页面切回前台时补一次解锁后的 BGM
    if (global.document && global.document.addEventListener) {
      global.document.addEventListener('visibilitychange', function () {
        if (!global.document.hidden) unlock();
      });
    }
  }

  global.SGS_AUDIO = api;
})(typeof window !== 'undefined' ? window : this);
