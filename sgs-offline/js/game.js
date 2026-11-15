/* 三国杀 · 单机版 — 规则引擎核心
 * 异步状态机：引擎在每个需要决策的点 await agent.decide(request)。
 * 人类 agent 由 UI 解析；AI agent 即时返回。
 */
(function (global) {
  'use strict';
  const D = global.SGS_DATA;
  const { CARDS, DECK_SPEC, GENERALS, SUITS, DUEL_POOL, NEW_DUEL_GENERALS, NEW_DUEL_BASE_NAMES } = D;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const MODES = {
    '8p': { roles: ['lord', 'loyalist', 'loyalist', 'rebel', 'rebel', 'rebel', 'rebel', 'renegade'], name: '八人身份局' },
    '5p': { roles: ['lord', 'loyalist', 'rebel', 'rebel', 'renegade'], name: '五人身份局' },
    '1v1': { roles: ['loyalist', 'rebel'], name: '单挑', duel: true },
    '2v2': { roles: ['team0', 'team1', 'team0', 'team1'], name: '2v2', team: true },
    '3v3': { roles: ['team0', 'team1', 'team0', 'team1', 'team0', 'team1'], name: '3v3', team: true },
    'ddz': { roles: ['landlord', 'farmer', 'farmer'], name: '斗地主', ddz: true },
  };

  class Game {
    constructor(opts = {}) {
      this.mode = opts.mode || '8p';
      this.duelPool = opts.duelPool || 'classic';
      this.cardPack = opts.cardPack || 'full';
      this.paceFactor = opts.paceFactor == null ? 0 : Number(opts.paceFactor);
      this.mulliganEnabled = opts.mulligan !== false;
      this.packs = opts.packs || ['标准', '风', '火', '林', '山'];
      // 变体扩展包默认关闭：只有 packs 显式含 'extras' 或 opts.extras===true 时才进入将池
      this.extrasEnabled = opts.extras != null ? !!opts.extras : (this.packs || []).includes('extras');
      this.seed = opts.seed == null ? (Date.now() & 0x7fffffff) : opts.seed;
      this.rng = mulberry32(this.seed);
      this.onUpdate = opts.onUpdate || (() => {});
      this.onSnapshot = opts.onSnapshot || null;
      this.started = false;
      this.ddzMultiplier = 1;
      this.agents = opts.agents || [];
      this.humanSeat = opts.humanSeat == null ? 0 : opts.humanSeat;
      this.players = [];
      this.deck = [];
      this.discardPile = [];
      this.table = [];
      this.logs = [];
      this.turnCount = 0;
      this.currentSeat = 0;
      this.phase = 'init';
      this.over = false;
      this.winner = null;
      this.winText = '';
      this.pendingRequest = null;
      this.recent = []; // 最近事件（UI 动画用）
      this.groupWaiting = [];
      this.paused = false;
      this._pauseWaiters = [];
      this.cardSeq = 0;
      this.ddzScene = opts.ddzScene || 'advanced'; // 基础场/高级场/练兵场
      this.ddzMaxMultiple = opts.ddzMaxMultiple || ((D.DDZ_SCENES || {})[this.ddzScene] || {}).maxMultiple || (D.DDZ_MAX_MULTIPLE || 4);
      this.ddzFierceAnnounced = false;
      this.stats = { damage: {}, kills: {} };
    }

    // ---------------- 基础工具 ----------------
    get modeDef() { return MODES[this.mode]; }
    rand(n) { return Math.floor(this.rng() * n); }
    pick(arr) { return arr[this.rand(arr.length)]; }
    shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = this.rand(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
    player(seat) { return this.players[seat]; }
    get alivePlayers() { return this.players.filter((p) => p.alive); }
    get lord() { return this.players.find((p) => p.role === 'lord'); }
    get teamMode() { return !!(this.modeDef && this.modeDef.team); }
    get ddzMode() { return !!(this.modeDef && this.modeDef.ddz); }
    // 斗地主“轮”：每名角色各行动一次为一轮
    get ddzRound() { return Math.ceil((this.turnCount || 1) / Math.max(1, this.players.length || 1)); }
    // 第 11 轮起进入鏖战（list7: fierceTurnCount=11）
    get ddzFierce() { return this.ddzMode && this.ddzRound >= 11; }
    // ---------------- 变体扩展包门控 ----------------
    // 默认关闭；main/ui 可通过 packs:['...','extras'] 或 opts.extras / setExtras(true) 开启。
    // setExtras 必须在 start()（setup 构建选将池）之前调用。
    extrasOn() { return !!this.extrasEnabled; }
    setExtras(on) { this.extrasEnabled = !!on; return this.extrasEnabled; }
    // 当前可用武将池：未启用 extras 时彻底排除 pack==='extras' 的 30 名变体将
    availableGenerals() { return GENERALS.filter((g) => this.extrasEnabled || g.pack !== 'extras'); }
    // 斗地主农民可互看手牌（引擎层判定；UI/AI 接入另做）
    canSeeHand(observer, target) {
      if (!this.ddzMode || !observer || !target) return false;
      if (observer.seat === target.seat) return true;
      return observer.role === 'farmer' && target.role === 'farmer';
    }
    teamName(r) { return r === 'team0' ? '蓝队' : r === 'team1' ? '红队' : this.roleName(r); }
    aliveOrder(startSeat, includeStart = false) {
      const n = this.players.length;
      const out = [];
      for (let i = includeStart ? 0 : 1; i <= n; i++) {
        const p = this.players[(startSeat + i) % n];
        if (p && p.alive) out.push(p);
      }
      return out;
    }
    nextAliveSeat(seat) {
      const n = this.players.length;
      for (let i = 1; i <= n; i++) {
        const s = (seat + i) % n;
        if (this.players[s].alive) return s;
      }
      return seat;
    }
    log(text, type = 'info') {
      const entry = { text, type, turn: this.turnCount, time: Date.now() };
      this.logs.push(entry);
      if (this.logs.length > 400) this.logs.shift();
      return entry;
    }
    emit() { try { this.onUpdate(this); } catch (e) { console.error(e); } }
    setPaused(v) {
      this.paused = !!v;
      if (!this.paused && this._pauseWaiters) {
        const ws = this._pauseWaiters.slice();
        this._pauseWaiters = [];
        ws.forEach((r) => { try { r(); } catch (e) { /* ignore */ } });
      }
    }
    async waitIfPaused() {
      while (this.paused) await new Promise((r) => this._pauseWaiters.push(r));
    }
    async pause(ms) {
      await this.waitIfPaused();
      const t = Math.round(ms * (this.paceFactor || 0));
      if (t > 0) await sleep(t);
      await this.waitIfPaused();
    }

    // ---------------- 设置 ----------------
    setup() {
      const def = this.modeDef;
      const n = def.roles.length;
      const roles = this.mode === 'ddz' ? ['farmer', 'farmer', 'farmer'] : ((this.mode === '1v1' || def.team) ? def.roles.slice() : this.shuffle(def.roles.slice()));
      // 武将池：每人 3 张候选（互不重复）
      const enabled = new Set(this.packs);
      let pool = this.shuffle(this.availableGenerals().filter((g) => enabled.has(g.pack)));
      if (this.mode === '1v1') {
        if (this.duelPool === 'new1v1') {
          // New1V1 独立将池：7 名晋将 + 39 名项目可用基础将（46/50，技能近似）
          const base = (GENERALS || []).filter((g) => (NEW_DUEL_BASE_NAMES || []).includes(g.name));
          pool = this.shuffle((NEW_DUEL_GENERALS || []).concat(base));
        } else {
          // 原版 1v1 为独立将池（全部免费），不受武将包勾选影响；
          // 变体扩展仍受 extras 门控（未开启时不会出现）
          pool = this.shuffle(this.availableGenerals());
          if (this.duelPool === 'classic') {
            const classic = pool.filter((g) => DUEL_POOL.indexOf(g.name) >= 0);
            if (classic.length >= 8) pool = classic; // 2 人 × 4 候选
          }
        }
      } else if (this.mode === '3v3') {
        // 原版欢乐33为独立将池，不受武将包勾选影响；变体扩展仍受 extras 门控
        pool = this.shuffle(this.availableGenerals());
      }
      let per = Math.min(5, Math.max(1, Math.floor(pool.length / n)));
      if (this.mode === '1v1') per = Math.min(4, per);
      if (def.team) per = 3;
      if (def.ddz) per = 3;
      const candidates = [];
      for (let i = 0; i < n; i++) candidates.push(pool.slice(i * per, (i + 1) * per));
      this.players = [];
      for (let seat = 0; seat < n; seat++) {
        this.players.push({
          seat,
          name: seat === this.humanSeat ? '你' : `玩家${seat + 1}`,
          role: roles[seat],
          isHuman: seat === this.humanSeat,
          candidates: candidates[seat],
          general: null,
          kingdom: '',
          gender: 'male',
          hp: 4,
          maxHp: 4,
          alive: true,
          hand: [],
          equips: { weapon: null, armor: null, offhorse: null, defhorse: null },
          judges: [],
          flags: {},
          used: {},
          once: {},
          chained: false,
          flipped: false,
          marks: {},
          revealed: false,
          givenRende: 0,
          slashCount: 0,
        });
      }
      const lordP = this.players.find((p) => p.role === 'lord');
      this.lordSeat = lordP ? lordP.seat : -1;
      this.currentSeat = this.lordSeat;
    }

    async draft() {
      for (const p of this.players) {
        const agent = this.agentOf(p);
        let choice = 0;
        if (p.isHuman) {
          const res = await this.ask(p, {
            type: 'chooseGeneral',
            player: p,
            candidates: p.candidates,
            reason: p.role === 'lord' ? '你是主公，请选择武将' : '请选择武将',
          });
          choice = res && res.index != null ? Number(res.index) : 0;
        } else {
          // AI 偏好：主公/忠臣偏防御辅助，反贼偏输出
          const scored = p.candidates.map((g, i) => ({ i, s: this.aiGeneralScore(p, g) })).sort((a, b) => b.s - a.s);
          choice = scored[0].i;
        }
        const g = p.candidates[Math.max(0, Math.min(choice, p.candidates.length - 1))];
        this.initGeneral(p, g);
      }
      this.emit();
    }

    aiGeneralScore(p, g) {
      let s = g.hp * 2;
      const offensive = { 关羽: 3, 张飞: 3, 吕布: 4, 马超: 2, 黄盖: 2, 许褚: 2, 貂蝉: 2, 甘宁: 2, 张辽: 2, 周瑜: 2 };
      const support = { 刘备: 3, 郭嘉: 3, 华佗: 3, 孙权: 2, 大乔: 2, 孙尚香: 2, 甄姬: 2, 陆逊: 2 };
      if (p.role === 'rebel') s += offensive[g.name] || 0;
      if (p.role === 'lord' || p.role === 'loyalist') s += support[g.name] || 0;
      if (p.role === 'renegade') s += 1;
      return s + this.rand(3);
    }

    initGeneral(p, g) {
      p.general = g;
      p.kingdom = g.kingdom;
      p.gender = g.gender;
      p.maxHp = g.hp + (p.role === 'lord' ? 1 : 0) + (this.ddzMode && p.role === 'landlord' ? 2 : 0);
      p.hp = p.maxHp;
      p.skills = g.skills.slice();
      p.marks = p.marks || {};
      if (p.skills.includes('j_xijue')) p.marks.jue = 4; // 袭爵：游戏开始时获得 4 枚“爵”
      if (p.role === 'lord') p.revealed = true;
    }

    // ---------------- agent / 询问 ----------------
    agentOf(p) { return this.agents[p.seat] || this.agents[0]; }
    async ask(p, req) {
      // 已阵亡角色不得再被询问（死亡技能/响应一律不再向死者发请求）
      if (!p || !p.alive) return null;
      req.player = p;
      this.pendingRequest = req;
      this.emit();
      const agent = this.agentOf(p);
      let res;
      try {
        res = await agent.decide(req);
      } finally {
        this.pendingRequest = null;
      }
      if (req.type === 'chooseCards' && Array.isArray(res)) {
        const pool = (req.cards || []).slice();
        const p2 = req.player;
        res = res.map((x) => {
          if (x && typeof x === 'object') return x;
          return pool.find((c) => c.id === x) || (p2 ? this.allCardsOf(p2).find((c) => c.id === x) : null) || null;
        }).filter(Boolean);
      }
      this.emit();
      return res;
    }

    // ---------------- 牌堆 ----------------
    buildDeck() {
      const cards = [];
      let id = 1;
      let spec;
      if (this.ddzMode) {
        // 斗地主专属牌堆：108 张（含炸弹/继往开来/攻守兼备/进退自如），不影响其他模式
        spec = (D.DECK_DDZ || []).slice();
      } else if (this.mode === '1v1') {
        spec = D.DECK_STANDARD.concat(D.DECK_MANEUVERING);
        const ban = Object.assign({}, D.DECK_1V1_BAN || {});
        spec = spec.filter(([name]) => {
          if ((ban[name] || 0) > 0) { ban[name] -= 1; return false; }
          return true;
        });
      } else if (this.cardPack === 'standard') spec = D.DECK_STANDARD.slice();
      else spec = D.DECK_STANDARD.concat(D.DECK_MANEUVERING);
      for (const [name, suit, rank] of spec) {
        const def = CARDS[name];
        cards.push({
          id: id++, name, suit, rank,
          type: def.type, subtype: def.subtype || null,
          range: def.range || 0,
          color: SUITS[suit].color,
        });
      }
      this.deck = this.shuffle(cards);
    }

    drawCards(p, n, reason = '') {
      if (!p || !p.alive) return [];
      const got = [];
      for (let i = 0; i < n; i++) {
        if (this.deck.length === 0) this.reshuffle();
        if (this.deck.length === 0) break;
        const c = this.deck.pop();
        p.hand.push(c); got.push(c);
      }
      if (got.length) this.log(`${this.nameOf(p)} 摸了 ${got.length} 张牌${reason ? '（' + reason + '）' : ''}`, 'draw');
      this.afterCardGain(p, got);
      return got;
    }

    reshuffle() {
      if (this.discardPile.length === 0) return;
      this.deck = this.shuffle(this.discardPile);
      this.discardPile = [];
      this.log('弃牌堆已洗入牌堆', 'system');
    }

    removeFromHand(p, ids) {
      const set = new Set(ids);
      const moved = p.hand.filter((c) => set.has(c.id));
      p.hand = p.hand.filter((c) => !set.has(c.id));
      return moved;
    }
    toDiscard(cards) {
      for (const c of [].concat(cards)) if (c) this.discardPile.push(c);
    }
    findCard(p, id) {
      return p.hand.find((c) => c.id === id) || Object.values(p.equips).find((c) => c && c.id === id) || p.judges.find((c) => c.id === id);
    }
    allCardsOf(p) {
      return [...p.hand, ...Object.values(p.equips).filter(Boolean), ...p.judges];
    }

    // ---------------- 主流程 ----------------
    async start() {
      this.setup();
      await this.draft();
      this.buildDeck();
      // 发牌：1v1 中 2 号位 +1；斗地主地主 +1
      for (const p of this.players) {
        let n = 4;
        if (this.mode === '1v1' && p.seat === 1) n = 5;
        // 原版欢乐33：六号位初始手牌 5 张，其他位置 4 张
        if (this.mode === '3v3' && p.seat === this.players.length - 1) n = 5;
        this.drawCards(p, n, '初始手牌');
      }
      await this.mulliganPhase();
      if (this.ddzMode) await this.ddzAuction();
      this.started = true;
      this.log(`【${this.modeDef.name}】开始！${this.lord ? '主公是 ' + this.nameOf(this.lord) : '对局开始'}`, 'system');
      this.emit();
      await this.pause(300);
      let startSeat = 0;
      if (this.lordSeat >= 0) startSeat = this.lordSeat;
      else if (this.ddzMode) startSeat = (this.players.find((p) => p.role === 'landlord') || {}).seat || 0;
      else if (this.teamMode) startSeat = this.rand(2); // 随机一方（队0的1号位/队1的1号位）先手
      this.currentSeat = startSeat;
      // 开局先落一次快照：若人类不是先手，刷新/关闭也能继续，而不是等到自己回合
      if (typeof this.onSnapshot === 'function') {
        try { this.onSnapshot(this.snapshot()); } catch (e) { /* 存档失败不影响对局 */ }
      }
      await this.runLoop();
    }

    async runLoop() {
      let guard = 0;
      while (!this.over && guard++ < 400) {
        await this.waitIfPaused();
        if (this.currentSeat === this.humanSeat && typeof this.onSnapshot === 'function') {
          try { this.onSnapshot(this.snapshot()); } catch (e) { /* 存档失败不影响对局 */ }
        }
        await this.takeTurn();
        if (this.over) break;
        if (this.extraTurnSeat != null) {
          const s2 = this.extraTurnSeat; this.extraTurnSeat = null;
          if (this.players[s2] && this.players[s2].alive) {
            this.log(`${this.nameOf(this.players[s2])} 执行【放权】的额外回合`, 'turn');
            this.currentSeat = s2;
            await this.takeTurn();
            if (this.over) break;
          }
        }
        this.currentSeat = this.nextAliveSeat(this.currentSeat);
      }
      if (!this.over) { this.over = true; this.winText = '对局超时（平局）'; }
      this.log(`对局结束：${this.winText}`, 'system');
      this.emit();
    }

    snapshot() {
      const players = this.players.map((p) => {
        const q = Object.assign({}, p);
        q.candidates = [];
        return q;
      });
      return {
        v: 1, mode: this.mode, humanSeat: this.humanSeat, seed: this.seed,
        cardPack: this.cardPack, packs: (this.packs || []).slice(), duelPool: this.duelPool,
        extras: !!this.extrasEnabled,
        turnCount: this.turnCount, currentSeat: this.currentSeat, ddzMultiplier: this.ddzMultiplier || 1,
        ddzScene: this.ddzScene,
        lordSeat: this.lordSeat, over: this.over, winner: this.winner, winText: this.winText,
        players: JSON.parse(JSON.stringify(players)),
        deck: JSON.parse(JSON.stringify(this.deck || [])),
        discardPile: JSON.parse(JSON.stringify(this.discardPile || [])),
        table: [], recent: [], logs: (this.logs || []).slice(-80),
        stats: JSON.parse(JSON.stringify(this.stats || {})),
      };
    }

    restore(snap) {
      if (!snap || !snap.players) throw new Error('存档无效');
      this.mode = snap.mode || this.mode;
      this.humanSeat = snap.humanSeat == null ? 0 : snap.humanSeat;
      this.seed = snap.seed || this.seed;
      this.cardPack = snap.cardPack || this.cardPack;
      this.duelPool = snap.duelPool || this.duelPool || 'classic';
      this.packs = (snap.packs || this.packs || []).slice();
      this.extrasEnabled = snap.extras != null ? !!snap.extras : (this.packs || []).includes('extras');
      this.players = snap.players.map((p) => Object.assign({}, p, { candidates: [] }));
      for (const p of this.players) {
        if (!p.equips) p.equips = { weapon: null, armor: null, horseMinus: null, horsePlus: null };
      }
      this.deck = snap.deck || [];
      this.discardPile = snap.discardPile || [];
      this.table = [];
      this.recent = [];
      this.logs = snap.logs || [];
      this.stats = snap.stats || {};
      this.turnCount = snap.turnCount || 0;
      this.ddzMultiplier = snap.ddzMultiplier || 1;
      if (snap.ddzScene) this.ddzScene = snap.ddzScene;
      this.ddzMaxMultiple = ((D.DDZ_SCENES || {})[this.ddzScene] || {}).maxMultiple || this.ddzMaxMultiple;
      this.currentSeat = snap.currentSeat == null ? 0 : snap.currentSeat;
      this.lordSeat = snap.lordSeat == null ? -1 : snap.lordSeat;
      this.over = false;
      this.started = true;
      this.winner = null;
      this.winText = '';
      this.extraTurnSeat = null;
      this.phase = 'prepare';
      this.emit();
    }

    async resume() {
      this.emit();
      await this.pause(250);
      await this.runLoop();
    }

    async ddzAuction() {
      const order = [0, 1, 2].sort(() => this.rand(3) - 1.5);
      let caller = null;
      let mult = 1;
      for (const seat of order) {
        const p = this.players[seat];
        if (!p) continue;
        const isRob = !!caller;
        const ids = isRob ? ['rob', 'pass'] : ['call', 'pass'];
        const labels = isRob ? ['抢地主（倍率×2）', '不抢'] : ['叫地主', '不叫'];
        const reason = isRob
          ? `${this.nameOf(caller)} 已叫地主，当前倍率 ×${mult}。${this.nameOf(p)} 是否抢地主？`
          : `${this.nameOf(p)} 是否叫地主？`;
        const r = await this.askOption(p, reason, ids, labels);
        if (!isRob && r === 'call') {
          caller = p;
          mult = 1;
          this.log(`${this.nameOf(p)} 叫地主`, 'turn');
        } else if (isRob && r === 'rob') {
          caller = p;
          mult *= 2;
          this.log(`${this.nameOf(p)} 抢地主，倍率 ×${mult}`, 'turn');
        }
      }
      if (!caller) {
        // 三家都不叫：按手牌强度强制一人当地主，倍率保持 1
        caller = this.players.slice().sort((a, b) => this.ddzHandScore(b) - this.ddzHandScore(a))[0];
        this.log('三家不叫，按手牌强度指定地主', 'turn');
      }
      this.players.forEach((p) => { p.role = 'farmer'; });
      caller.role = 'landlord';
      // 斗地主农民技能：聚众、共济（地主没有）
      this.players.forEach((p) => {
        p.skills = (p.skills || []).filter((s2) => s2 !== 'juzhong' && s2 !== 'gongji');
        if (p.role === 'farmer') p.skills.push('juzhong', 'gongji');
      });
      // 原版：地主初始体力固定为 4 点（不再按武将体力 +2）
      caller.maxHp = 4;
      caller.hp = 4;
      this.drawCards(caller, 2, '地主底牌');
      // 地契：游戏开始时置入地主的防具栏（原版 6104）
      caller.equips.armor = this.makeCard('diqi', 'club', 13, 10001);
      this.log(`${this.nameOf(caller)} 获得【地契】（置入防具栏）`, 'equip');
      this.ddzMultiplier = mult;
      this.currentSeat = caller.seat;
      this.log(`地主是 ${this.nameOf(caller)}，倍率 ×${mult}`, 'system');
      await this.ddzPickSecondGeneral(caller);
      this.emit();
    }

    // 地主双将：叫/抢地主结束后，向地主再次发起 chooseGeneral（排除已选将）
    async ddzPickSecondGeneral(lord) {
      if (!this.ddzMode || !lord || lord.secondGeneral) return;
      const used = new Set();
      for (const p of this.players) {
        if (p.general) { used.add(p.general.id); used.add(p.general.name); }
      }
      const pool = this.availableGenerals().filter((g) => !used.has(g.id) && !used.has(g.name));
      if (!pool.length) return;
      const res = await this.ask(lord, {
        type: 'chooseGeneral', player: lord, candidates: pool,
        reason: '地主双将：请选择你的第二武将（技能合并，体力仍为 4）',
      });
      let idx = res && res.index != null ? Number(res.index) : 0;
      if (!Number.isFinite(idx) || idx < 0 || idx >= pool.length) idx = 0;
      const g2 = pool[idx];
      lord.secondGeneral = g2;
      for (const s2 of (g2.skills || [])) if (!lord.skills.includes(s2)) lord.skills.push(s2);
      const names = (g2.skills || []).map((s2) => (D.SKILLS[s2] ? D.SKILLS[s2].name : s2)).join('、');
      this.log(`${this.nameOf(lord)} 地主双将：第二武将 ${g2.name}，获得技能 ${names}（体力仍为 4）`, 'skill');
      this.emit();
    }

    ddzHandScore(p) {
      const val = { sha: 3, huosha: 4, leisha: 4, tao: 3, wuzhong: 4, juedou: 3, shunshou: 3, guohe: 2, wuxie: 2, jiu: 2 };
      let s = 0;
      (p.hand || []).forEach((c) => { s += val[c.name] || 1; });
      return s + this.rand(3);
    }

    async mulliganPhase() {
      // 手气卡选择暂时关闭
      return;
      if (!this.mulliganEnabled || this.humanSeat < 0) return;
      const p = this.players[this.humanSeat];
      if (!p) return;
      let count = this.ddzMode ? 0 : (this.mode === '1v1' ? (p.seat === 0 ? 1 : 2) : (this.teamMode ? 1 : 3));
      while (count > 0) {
        const n = p.hand.length;
        const r = await this.askOption(p, `是否使用手气卡？弃置全部手牌并重摸 ${n} 张（剩余 ${count} 次）`, ['yes', 'no'], ['使用', '保留手牌']);
        if (r !== 'yes') break;
        count -= 1;
        this.toDiscard(p.hand.slice());
        p.hand = [];
        this.drawCards(p, n, '手气卡');
        this.emit();
      }
    }

    nameOf(p) {
      if (!p) return '无人';
      return p.isHuman ? `你（${p.general ? p.general.name : ''}）` : `${p.general ? p.general.name : p.name}`;
    }

    async takeTurn() {
      const p = this.players[this.currentSeat];
      if (!p.alive) return;
      if (p.flipped) {
        p.flipped = false;
        this.log(`${this.nameOf(p)} 武将牌背面朝上，跳过本回合`, 'turn');
        this.emit();
        return;
      }
      this.turnCount++;
      if (this.ddzMode && this.ddzFierce && !this.ddzFierceAnnounced) {
        this.ddzFierceAnnounced = true;
        this.log('第 11 轮起进入鏖战模式：桃只能当【杀】或【闪】使用或打出，且不能聚众/响应聚众', 'system');
      }
      // 义绝/铁骑的“本回合”状态：新回合开始时清除上一回合的标记
      for (const q of this.players) {
        if (q.flags && (q.flags.noSkills || q.flags.noHand)) { delete q.flags.noSkills; delete q.flags.noHand; }
      }
      p.flags = {};
      p.used = {};
      p.slashCount = 0;
      p.givenRende = 0;
      p.damageBonus = 0;
      p.drank = 0;
      p.skip = {};
      this.log(`—— 第 ${this.turnCount} 回合：${this.nameOf(p)} ——`, 'turn');
      this.emit();
      await this.phaseStart(p);
      if (this.over || !p.alive) return;
      await this.phaseJudge(p);
      if (this.over || !p.alive) return;
      await this.phaseDraw(p);
      if (this.over || !p.alive) return;
      if (!p.skip.play) await this.phasePlay(p);
      if (this.over || !p.alive) return;
      if (!p.skip.discard) await this.phaseDiscard(p);
      if (this.over || !p.alive) return;
      await this.phaseEnd(p);
    }

    async phaseStart(p) {
      this.phase = 'start';
      this.emit();
      await this.pause(400);
      if (p.skills.includes('guanxing')) await this.skillGuanxing(p);
      if (p.skills.includes('luoshen') || p.skills.includes('j_luoshen')) await this.skillLuoshen(p, p.skills.includes('j_luoshen'));
      await this.skillTrigger('phaseStart', p);
    }

    async phaseJudge(p) {
      this.phase = 'judge';
      this.emit();
      await this.pause(450);
      if (!p.skip.judge) await this.skillPhaseHook(p, 'judge');
      if (p.skip.judge) { this.log(`${this.nameOf(p)} 跳过判定阶段`, 'turn'); return; }
      const judges = p.judges.slice();
      for (const jc of judges) {
        if (!p.alive) return;
        if (!p.judges.find((c) => c.id === jc.id)) continue;
        if (await this.isNullified(jc, p, null)) {
          jc._resolved = true;
          this.toDiscard(jc);
          this.log(`【无懈可击】抵消了 ${this.cardText(jc)}`, 'wuxie');
          this.emit();
          continue;
        }
        // 谦逊（陆逊 Po）：延时锦囊生效前，可将所有手牌移出游戏直到回合结束
        if (!p.flags.noSkills && p.skills.includes('j_qianxun') && p.hand.length) await this.qianxunExile(p);
        if (jc.name === 'lebu') {
          await this.delayedTrickJudge(p, jc, (card) => card.suit === 'heart', false);
          if (!p.alive) return;
          if (jc._bad) { p.skip.play = true; this.log(`${this.nameOf(p)} 判定为 ${this.cardText(jc._judgeCard)}，跳过出牌阶段`, 'judge'); }
        } else if (jc.name === 'bingliang') {
          await this.delayedTrickJudge(p, jc, (card) => card.suit === 'club', false);
          if (!p.alive) return;
          if (jc._bad) { p.skip.draw = true; this.log(`${this.nameOf(p)} 判定为 ${this.cardText(jc._judgeCard)}，跳过摸牌阶段`, 'judge'); }
        } else if (jc.name === 'shandian') {
          await this.delayedTrickJudge(p, jc, (card) => card.suit === 'spade' && card.rank >= 2 && card.rank <= 9, true);
          if (!p.alive) return;
          if (jc._bad) {
            this.log(`${this.nameOf(p)} 的【闪电】命中，受到 3 点雷电伤害`, 'judge');
            await this.damage({ source: null, target: p, amount: 3, nature: 'thunder', card: jc });
            if (!p.alive) return;
          } else if (jc._moved) {
            this.log(`【闪电】移动到 ${this.nameOf(jc._moved)} 的判定区`, 'judge');
          }
        }
      }
      p.judges = p.judges.filter((c) => !c._resolved);
      this.emit();
    }

    async delayedTrickJudge(p, jc, successFn, isLightning) {
      const res = await this.judge(p, jc.name);
      jc._judgeCard = res.card;
      const success = successFn(res.card);
      jc._resolved = true;
      if (isLightning) {
        jc._bad = success;
        if (success) this.toDiscard(jc);
        else {
          // 移到下家判定区
          let seat = this.nextAliveSeat(p.seat);
          let guard = 0;
          while (guard++ < this.players.length) {
            const q = this.players[seat];
            if (!q.judges.some((c) => c.name === 'shandian')) break;
            seat = this.nextAliveSeat(seat);
          }
          const q = this.players[seat];
          if (q && q.seat !== p.seat && !q.judges.some((c) => c.name === 'shandian')) {
            p.judges = p.judges.filter((c) => c.id !== jc.id);
            jc._resolved = true;
            q.judges.push(jc);
            jc._moved = q;
          } else {
            this.toDiscard(jc);
          }
        }
      } else {
        jc._bad = !success;
        this.toDiscard(jc);
      }
      this.emit();
    }

    async phaseDraw(p) {
      this.phase = 'draw';
      this.emit();
      await this.pause(350);
      if (p.skip.draw) { this.log(`${this.nameOf(p)} 跳过摸牌阶段`, 'turn'); return; }
      await this.skillPhaseHook(p, 'draw');
      if (p.skip.draw) { this.log(`${this.nameOf(p)} 跳过摸牌阶段`, 'turn'); return; }
      const handled = await this.skillTrigger('drawPhase', p);
      if (handled) { this.emit(); return; }
      // 裸衣（许褚 Po）：摸牌阶段开始前亮出牌堆顶 3 张，可跳过摸牌并获得其中基本/武器/决斗
      if (p.skills.includes('j_luoyi')) {
        const r = await this.askOption(p, '【裸衣】：是否亮出牌堆顶三张牌？', ['yes', 'no'], ['发动', '不发动']);
        if (r === 'yes') {
          const cards = [];
          for (let i = 0; i < 3; i++) { if (this.deck.length === 0) this.reshuffle(); if (this.deck.length) cards.push(this.deck.pop()); }
          if (cards.length) {
            const eligible = cards.filter((c) => c.type === 'basic' || (c.type === 'equip' && c.subtype === 'weapon') || c.name === 'juedou');
            this.log(`${this.nameOf(p)} 发动【裸衣】亮出：${cards.map((c) => this.cardText(c)).join('、')}`, 'skill');
            this.emit();
            const skip = await this.askOption(p, `【裸衣】：是否跳过摸牌阶段并获得其中 ${eligible.length} 张（基本牌/武器牌/【决斗】）？`, ['yes', 'no'], ['跳过并获得', '不跳过']);
            if (skip === 'yes') {
              for (const c of eligible) { p.hand.push(c); this.afterCardGain(p, [c]); }
              const rest = cards.filter((c) => eligible.indexOf(c) < 0);
              this.toDiscard(rest);
              p.flags = p.flags || {};
              p.flags.luoyiBonus = true;
              this.log(`${this.nameOf(p)} 发动【裸衣】获得 ${eligible.length} 张牌，直到下回合开始【杀】/【决斗】伤害 +1`, 'skill');
              this.emit();
              return;
            }
            // 不跳过：按原顺序放回牌堆顶
            for (let i = cards.length - 1; i >= 0; i--) this.deck.push(cards[i]);
          }
        }
      }
      // 袭爵（张虎乐綝）：移除 1 枚“爵”发动突袭
      if (p.skills.includes('j_xijue') && (p.marks.jue || 0) > 0 && this.alivePlayers.some((q) => q.seat !== p.seat && q.hand.length)) {
        const r = await this.askOption(p, `【袭爵】：是否移除 1 枚“爵”（剩余 ${p.marks.jue}）发动【突袭】？`, ['yes', 'no'], ['发动', '不发动']);
        if (r === 'yes') {
          p.marks.jue -= 1;
          if (await this.tuxiPoEffect(p)) return;
          p.marks.jue += 1; // 未实际发动（选择少摸 0 张）则退回“爵”
        }
      }
      // 突袭（张辽 Po）：少摸任意张牌，获得等量其他角色的各一张手牌
      if (p.skills.includes('j_tuxi')) {
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && q.hand.length > 0);
        if (cands.length) {
          const res = await this.ask(p, {
            type: 'chooseOption', player: p, reason: '是否发动【突袭】？你可以少摸任意张牌，并获得等量其他角色的各一张手牌',
            options: [{ id: 'yes', label: '发动突袭' }, { id: 'no', label: '正常摸牌' }],
          });
          if (res === 'yes' && await this.tuxiPoEffect(p)) return;
        }
      }
      // 突袭
      if (p.skills.includes('tuxi')) {
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && q.hand.length > 0);
        if (cands.length) {
          const res = await this.ask(p, {
            type: 'chooseOption', player: p, reason: '是否发动【突袭】？放弃摸牌，改为获得至多两名其他角色的各一张手牌',
            options: [{ id: 'yes', label: '发动突袭' }, { id: 'no', label: '正常摸牌' }],
          });
          if (res === 'yes') {
            const t = await this.ask(p, {
              type: 'chooseTargets', player: p, reason: '选择至多两名有手牌的角色', candidates: cands.map((q) => q.seat), min: 1, max: 2,
            });
            const seats = (t || []).slice(0, 2);
            for (const s of seats) {
              const q = this.players[s];
              if (q.hand.length) {
                const c = q.hand[this.rand(q.hand.length)];
                q.hand = q.hand.filter((x) => x.id !== c.id);
                p.hand.push(c);
                this.afterCardGain(p, [c]);
                await this.afterLoseCards(q, [c], true);
                this.log(`${this.nameOf(p)} 发动【突袭】获得 ${this.nameOf(q)} 一张手牌`, 'skill');
              }
            }
            this.emit();
            return;
          }
        }
      }
      // 慧识（张春华）：改为观看牌堆顶 X 张，获得其中一半，其余置底
      if (p.skills.includes('j_huishi')) {
        const r = await this.askOption(p, '【慧识】：是否改为观看牌堆顶 X 张牌（X=牌堆数个数位），获得其中一半？', ['yes', 'no'], ['发动', '正常摸牌']);
        if (r === 'yes') { await this.huishi(p); this.emit(); return; }
      }
      let n = 2;
      if (this.ddzMode && p.role === 'landlord') n += 1;
      // 原版欢乐33：首轮一号位摸牌 1 张，其他位置摸牌 2 张
      if (this.mode === '3v3' && p.seat === 0 && this.turnCount <= this.players.length) n = 1;
      if (this.mode === '1v1' && p.seat === 0 && !p.duelFirstDraw) { n = Math.max(0, n - 1); p.duelFirstDraw = true; this.log('1 号位首轮摸牌 -1', 'info'); }
      if (p.skills.includes('yingzi') || p.skills.includes('j_yingzi')) n += 1;
      if (p.skills.includes('luoyi')) {
        const res = await this.ask(p, {
          type: 'chooseOption', player: p, reason: '是否发动【裸衣】？少摸一张牌，本回合你的【杀】和【决斗】伤害 +1',
          options: [{ id: 'yes', label: '发动裸衣' }, { id: 'no', label: '正常摸牌' }],
        });
        if (res === 'yes') { n = Math.max(0, n - 1); p.damageBonus = 1; this.log(`${this.nameOf(p)} 发动【裸衣】`, 'skill'); }
      }
      this.drawCards(p, n, '摸牌阶段');
      this.emit();
    }

    // 突袭（张辽 Po / 袭爵）通用效果：少摸 k 张，获得 k 名角色各一张手牌
    async tuxiPoEffect(p) {
      const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && q.hand.length > 0);
      if (!cands.length) return false;
      const maxK = Math.min(2, cands.length);
      const opts = [];
      for (let k = 1; k <= maxK; k++) opts.push({ id: String(k), label: `少摸 ${k} 张，获得 ${k} 名角色各一张手牌` });
      opts.push({ id: '0', label: '不发动（正常摸牌）' });
      const kr = await this.ask(p, { type: 'chooseOption', player: p, reason: '【突袭】：选择少摸的张数', options: opts });
      const k = Number(kr) || 0;
      if (k <= 0) return false;
      const t = await this.ask(p, { type: 'chooseTargets', player: p, reason: `突袭：选择 ${k} 名有手牌的角色`, candidates: cands.map((q) => q.seat), min: k, max: k });
      let got = 0;
      for (const seat of (t || []).slice(0, k)) {
        const q = this.players[seat];
        if (q && q.hand.length) {
          const c = q.hand[this.rand(q.hand.length)];
          q.hand = q.hand.filter((x) => x.id !== c.id);
          p.hand.push(c);
          this.afterCardGain(p, [c]);
          await this.afterLoseCards(q, [c], true);
          got++;
          this.log(`${this.nameOf(p)} 发动【突袭】获得 ${this.nameOf(q)} 一张手牌`, 'skill');
        }
      }
      this.drawCards(p, Math.max(0, 2 - got), '突袭');
      this.emit();
      return true;
    }

    // 慧识（张春华）：观看牌堆顶 X 张（X=牌堆数个数位），获得一半（向下取整），其余置底
    async huishi(p) {
      if (this.deck.length === 0) this.reshuffle();
      const x = this.deck.length % 10;
      const cards = [];
      for (let i = 0; i < x; i++) { const c = this.deck.pop(); if (c) cards.push(c); }
      const gain = Math.floor(cards.length / 2);
      let chosen = [];
      if (gain > 0) {
        const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: `慧识：选择获得其中 ${gain} 张牌`, cards: cards.slice(), min: gain, max: gain });
        chosen = (sel || []).slice(0, gain)
          .map((s2) => (s2 && typeof s2 === 'object' ? s2 : cards.find((c) => c.id === s2)))
          .filter(Boolean);
      }
      const rest = cards.filter((c) => !chosen.some((c2) => c2.id === c.id));
      for (const c of chosen) { p.hand.push(c); this.afterCardGain(p, [c]); }
      if (rest.length) this.deck.unshift(...rest);
      this.log(`${this.nameOf(p)} 发动【慧识】：观看 ${cards.length} 张，获得 ${chosen.length} 张，其余 ${rest.length} 张置于牌堆底`, 'skill');
      this.emit();
    }

    async phasePlay(p) {
      this.phase = 'play';
      this.emit();
      await this.skillPhaseHook(p, 'play');
      if (p.skip.play) { this.log(`${this.nameOf(p)} 跳过出牌阶段`, 'turn'); return; }
      let guard = 0;
      while (p.alive && !this.over && !p.skip.play && guard++ < 100) {
        const actions = this.buildPlayActions(p);
        const res = await this.ask(p, {
          type: 'play', player: p, actions, reason: '出牌阶段',
        });
        const action = res && res.action ? res.action : res;
        if (!action || action.kind === 'end') break;
        await this.executeAction(p, action);
        this.emit();
      }
    }

    async phaseDiscard(p) {
      this.phase = 'discard';
      this.emit();
      await this.pause(300);
      await this.skillPhaseHook(p, 'discard');
      if (p.skip.discard) { this.log(`${this.nameOf(p)} 跳过弃牌阶段`, 'turn'); return; }
      if (p.skills.includes('keji') && p.slashCount === 0) {
        const res = await this.ask(p, {
          type: 'chooseOption', player: p, reason: '是否发动【克己】跳过弃牌阶段？',
          options: [{ id: 'yes', label: '发动克己' }, { id: 'no', label: '正常弃牌' }],
        });
        if (res === 'yes') { this.log(`${this.nameOf(p)} 发动【克己】，跳过弃牌阶段`, 'skill'); return; }
      }
      let limit = Math.max(0, p.hp);
      // 英姿（周瑜 Po）：手牌上限为体力上限
      if (p.skills.includes('j_yingzi')) limit = Math.max(0, p.maxHp);
      // 洛神（甄姬 Po）：本回合以此法获得的牌不计入手牌上限
      if (p.skills.includes('j_luoshen') && Array.isArray(p.flags.luoshenIds)) {
        limit += p.hand.filter((c) => p.flags.luoshenIds.indexOf(c.id) >= 0).length;
      }
      // 集智（黄月英 Po）：本回合手牌上限 +X
      if (p.skills.includes('j_jizhi') && p.flags.jizhiLimit) limit += p.flags.jizhiLimit;
      // 清俭：令当前回合角色本回合手牌上限 +X
      if (p.flags.qingjianLimit) limit += p.flags.qingjianLimit;
      // 宴戏：本回合以此法获得的牌不计入手牌上限
      if (Array.isArray(p.flags.yanxiIds)) limit += p.hand.filter((c) => p.flags.yanxiIds.indexOf(c.id) >= 0).length;
      if (p.skills.includes('xueyi')) limit += 2 * this.alivePlayers.filter((q) => q.kingdom === '群' && q.seat !== p.seat).length;
      p.lastDiscarded = [];
      const over = p.hand.length - limit;
      if (over > 0) {
        const cards = await this.ask(p, {
          type: 'chooseCards', player: p, reason: `弃牌阶段：请弃置 ${over} 张手牌`,
          cards: p.hand.slice(), min: over, max: over, from: 'hand',
        });
        const chosen = (cards || []).slice(0, over);
        const moved = this.removeFromHand(p, chosen.map((c) => c.id));
        this.toDiscard(moved);
        p.lastDiscarded = moved.slice();
        this.log(`${this.nameOf(p)} 弃置了 ${moved.length} 张牌`, 'discard');
        this.afterLoseCards(p, moved);
        // 固政
        const gz = this.alivePlayers.find((q) => q.seat !== p.seat && q.skills.includes('guzheng'));
        if (gz && moved.length) {
          const r = await this.askOption(gz, `【固政】：是否令 ${this.nameOf(p)} 获得其中一张，其余归你？`, ['yes', 'no'], ['发动', '放弃']);
          if (r === 'yes') {
            const sel = await this.ask(gz, { type: 'chooseCards', player: gz, reason: `固政：选择交给 ${this.nameOf(p)} 的一张牌`, cards: moved.slice(), min: 1, max: 1 });
            const give = (sel && sel.length) ? moved.find((c) => c.id === sel[0].id) : moved[0];
            this.discardPile = this.discardPile.filter((c) => !moved.includes(c));
            if (give) {
              p.hand.push(give);
              this.afterCardGain(p, [give]);
            }
            for (const c of moved) if (c !== give) { gz.hand.push(c); this.afterCardGain(gz, [c]); }
            this.log(`${this.nameOf(gz)} 发动【固政】：${give ? this.cardText(give) + ' 还给 ' + this.nameOf(p) + '，' : ''}其余 ${moved.length - (give ? 1 : 0)} 张归自己`, 'skill');
          }
        }
      }
      this.emit();
    }

    async phaseEnd(p) {
      this.phase = 'end';
      this.emit();
      await this.pause(300);
      await this.skillTrigger('endPhase', p);
      if (p.alive && p.flags.fangquan != null && p.flags.fangquan >= 0) {
        const t = this.players[p.flags.fangquan];
        if (t && t.alive && p.hand.length) {
          const r = await this.askOption(p, `【放权】：是否弃置一张手牌，令 ${this.nameOf(t)} 获得额外回合？`, ['yes', 'no'], ['发动', '放弃']);
          if (r === 'yes') {
            const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: '放权：弃置一张手牌，令目标获得额外回合', cards: p.hand.slice(), min: 1, max: 1 });
            const c = sel && sel.length ? this.findCard(p, sel[0].id) : null;
            if (c) {
              p.hand = p.hand.filter((x) => x.id !== c.id);
              this.toDiscard([c]);
              await this.afterLoseCards(p, [c]);
              this.extraTurnSeat = t.seat;
              this.log(`${this.nameOf(p)} 发动【放权】，${this.nameOf(t)} 将获得额外回合`, 'skill');
            }
          }
        } else if (t && t.alive) {
          this.log(`【放权】${this.nameOf(p)} 没有手牌可弃，无法令 ${this.nameOf(t)} 获得额外回合`, 'info');
        }
        p.flags.fangquan = -1;
      }
      if (p.alive && p.skills.includes('biyue')) {
        this.drawCards(p, 1, '闭月');
        this.log(`${this.nameOf(p)} 发动【闭月】摸一张牌`, 'skill');
      }
      if (p.alive && p.skills.includes('j_biyue')) {
        const n = p.hand.length === 0 ? 2 : 1;
        this.drawCards(p, n, '闭月');
        this.log(`${this.nameOf(p)} 发动【闭月】摸 ${n} 张牌`, 'skill');
      }
      // 泰然（司马师）：结束阶段回复所有体力，手牌摸至体力上限
      if (p.alive && p.skills.includes('j_tairan')) {
        const real = await this.recover(p, Math.max(0, p.maxHp - p.hp), p, '泰然');
        const want = Math.max(0, p.maxHp - p.hand.length);
        const drawn = want > 0 ? this.drawCards(p, want, '泰然') : [];
        p.flags = p.flags || {};
        p.flags.tairan = { hp: real, ids: (drawn || []).map((c) => c.id) };
        this.log(`${this.nameOf(p)} 发动【泰然】回复 ${real} 点体力并摸 ${(drawn || []).length} 张牌`, 'skill');
        this.emit();
      }
      // 筹伐（司马昭）：效果持续到目标回合结束
      if (p.marks && p.marks.choufaType) delete p.marks.choufaType;
      // 谦逊：回合结束时将移出游戏的手牌移回
      await this.returnExile();
      this.emit();
    }

    // ---------------- 判定 ----------------
    async judge(who, reason) {
      if (this.deck.length === 0) this.reshuffle();
      let phys = this.deck.pop();
      if (!phys) { phys = { id: -1, name: '无', suit: 'spade', rank: 1, color: 'black' }; }
      // 红颜等改花色技能只影响本次判定视图，不改写牌堆里的实体牌
      let card = this.effCard(who, phys);
      const reasonLabel = (CARDS[reason] && CARDS[reason].name) || reason;
      this.log(`${this.nameOf(who)} 判定（${reasonLabel}）：${this.cardText(card)}`, 'judge');
      // 结构化判定事件：不依赖日志文本解析，延时锦囊/八卦/铁骑都走同一浮层
      this.recent.push({
        kind: 'judge', seat: who.seat,
        reason: (CARDS[reason] && CARDS[reason].name) || reason,
        who: this.nameOf(who),
        card: { name: card.name, suit: card.suit, rank: card.rank, color: card.color },
      });
      if (this.recent.length > 200) this.recent.shift();
      this.emit();
      // 鬼才 / 鬼道：每名有此技能的角色各获得一次改判机会
      const canGuicai = (q) => {
        if (q.flags && q.flags.noSkills) return false;
        if (q.skills.includes('guicai') && q.hand.length) return true;
        if (q.skills.includes('j_guicai') && (q.hand.length || Object.values(q.equips).filter(Boolean).length)) return true;
        if (q.skills.includes('guidao')) {
          const pool = [...q.hand, ...Object.values(q.equips).filter(Boolean)];
          return pool.some((c) => this.colorOf(q, c) === 'black');
        }
        return false;
      };
      for (const guicai of this.alivePlayers.filter(canGuicai)) {
        const replaced = await this.skillGuicai(guicai, who, card, reason);
        if (replaced) {
          this.toDiscard(phys);
          phys = replaced;
          card = replaced;
          this.log(`【鬼才/鬼道】判定牌改为 ${this.cardText(card)}`, 'skill');
          this.emit();
        }
      }
      // 颂威：魏势力角色判定为黑色，曹丕主公摸一张
      const songweiLord = this.lord;
      if (songweiLord && songweiLord.alive && !songweiLord.flags.noSkills && songweiLord.skills.includes('songwei') && who.alive && who.kingdom === '魏' && who.seat !== songweiLord.seat && card.color === 'black') {
        const r = await this.askOption(who, `【颂威】：是否令主公 ${this.nameOf(songweiLord)} 摸一张牌？`, ['yes', 'no'], ['发动', '放弃']);
        if (r === 'yes') this.drawCards(songweiLord, 1, '颂威');
      }
      // 天妒
      if (who.alive && !who.flags.noSkills && who.skills.includes('tiandu')) {
        const res = await this.ask(who, {
          type: 'chooseOption', player: who, reason: '是否发动【天妒】获得此判定牌？',
          options: [{ id: 'yes', label: '获得判定牌' }, { id: 'no', label: '放弃' }],
        });
        if (res === 'yes') {
          who.hand.push(phys);
          this.afterCardGain(who, [phys]);
          this.log(`${this.nameOf(who)} 发动【天妒】获得判定牌`, 'skill');
          this.emit();
          return { card, gained: true };
        }
      }
      this.toDiscard(phys);
      return { card, gained: false };
    }

    // ---------------- 伤害 / 回复 / 濒死 ----------------
    async recover(p, amount, source, reason = '') {
      if (!p.alive) return 0;
      // 救援（孙权 Po，主公技）：其他吴势力角色于其回合内回复体力时，若其体力≥主公，可改为令主公回复1并摸一张
      if (amount > 0 && !this._inJiuyuan && p.kingdom === '吴' && p.role !== 'lord' && this.currentSeat === p.seat) {
        const jl = this.lord;
        if (jl && jl.alive && !jl.flags.noSkills && jl.role === 'lord' && jl.skills.includes('j_jiuyuan') && p.hp >= jl.hp) {
          const r = await this.askOption(p, `【救援】：是否改为令主公 ${this.nameOf(jl)} 回复 1 点体力，然后你摸一张牌？`, ['yes', 'no'], ['发动', '不发动']);
          if (r === 'yes') {
            this._inJiuyuan = true;
            await this.recover(jl, 1, jl, '救援');
            this._inJiuyuan = false;
            this.drawCards(p, 1, '救援');
            this.log(`${this.nameOf(p)} 发动【救援】，令主公 ${this.nameOf(jl)} 回复 1 点体力并摸一张牌`, 'skill');
            this.emit();
            return 0;
          }
        }
      }
      const before = p.hp;
      p.hp = Math.min(p.maxHp, p.hp + amount);
      const real = p.hp - before;
      if (real > 0) { p.flags.buquSafe = false; this.log(`${this.nameOf(p)} 回复 ${real} 点体力${reason ? '（' + reason + '）' : ''}`, 'heal'); }
      this.emit();
      return real;
    }

    async loseHp(p, amount, reason = '') {
      if (!p.alive) return;
      p.hp -= amount;
      this.log(`${this.nameOf(p)} 失去 ${amount} 点体力${reason ? '（' + reason + '）' : ''}`, 'damage');
      // 诈降（黄盖 Po，锁定技）：失去 1 点体力后摸三张牌；出牌阶段额外获得本回合杀强化
      if (p.alive && p.skills.includes('j_zhaxiang') && amount > 0) {
        this.drawCards(p, 3, '诈降');
        if (this.phase === 'play' && this.currentSeat === p.seat) {
          p.flags = p.flags || {};
          p.flags.zhaxiang = true;
          this.log(`${this.nameOf(p)} 发动【诈降】：本回合【杀】次数 +1，红色【杀】无距离限制且不能被抵消`, 'skill');
        } else {
          this.log(`${this.nameOf(p)} 发动【诈降】摸三张牌`, 'skill');
        }
        this.emit();
      }
      if (p.hp <= 0) await this.dying(p, null);
      // 失去体力同样会致死：濒死未被救回且无【不屈】豁免时须阵亡
      if (p.hp <= 0 && p.alive && !p.flags.buquSafe) await this.kill(p, null);
    }

    async damage(opts) {
      const { source, target, amount = 1, nature = 'normal', card = null, reason = '' } = opts;
      if (!target.alive || this.over) return 0;
      // 共济（限定技，斗地主农民）：队友受到伤害时，可弃一张牌将伤害转移给自己
      if (!opts.noGongji && this.ddzMode && target.role === 'farmer') {
        const mate = this.alivePlayers.find((q) => q.role === 'farmer' && q.seat !== target.seat && q.skills.includes('gongji') && !q.once.gongji && this.selectableCards(q).length);
        if (mate) {
          const r = await this.askOption(mate, `【共济（限定技）】：是否弃置一张牌，代替 ${this.nameOf(target)} 受到此次伤害？`, ['yes', 'no'], ['发动', '不发动']);
          if (r === 'yes') {
            const pool = this.selectableCards(mate);
            const sel = await this.ask(mate, { type: 'chooseCards', player: mate, reason: '共济：弃置一张牌', cards: pool, min: 1, max: 1 });
            const c = sel && sel.length ? this.findCard(mate, sel[0].id) : null;
            if (c) {
              mate.once.gongji = true;
              this.removeAnyCard(mate, c.id);
              this.toDiscard([c]);
              await this.afterLoseCards(mate, [c]);
              await this.juzhongAfterDiscard(mate);
              this.log(`${this.nameOf(mate)} 发动【共济】弃置 ${this.cardText(c)}，代替 ${this.nameOf(target)} 受到此伤害`, 'skill');
              this.emit();
              return await this.damage({ source, target: mate, amount, nature, card, reason: reason || '共济', noGongji: true });
            }
          }
        }
      }
      // 天香：受到伤害时转移
      if (!target.flags.noSkills && target.skills.includes('tianxiang') && !opts.noTianxiang && target.hand.some((c) => this.suitOf(target, c) === 'heart')) {
        const cands = this.alivePlayers.filter((q) => q.seat !== target.seat);
        if (cands.length) {
          const r = await this.ask(target, {
            type: 'chooseOption', player: target,
            reason: '是否发动【天香】弃一张红桃手牌，将此伤害转移给一名其他角色？',
            options: [{ id: 'yes', label: '发动天香' }, { id: 'no', label: '承受伤害' }],
          });
          if (r === 'yes') {
            const hearts = target.hand.filter((c) => this.suitOf(target, c) === 'heart');
            const sel = await this.ask(target, { type: 'chooseCards', player: target, reason: '天香：弃置一张红桃手牌', cards: hearts, min: 1, max: 1 });
            if (sel && sel.length) {
              const c = target.hand.find((x) => x.id === sel[0].id);
              target.hand = target.hand.filter((x) => x !== c);
              this.toDiscard([c]);
              this.afterLoseCards(target, [c]);
              const ts = await this.ask(target, { type: 'chooseTargets', player: target, reason: '天香：选择伤害转移目标', candidates: cands.map((q) => q.seat), min: 1, max: 1 });
              const to = ts && this.players[ts[0]];
              if (to) {
                this.log(`${this.nameOf(target)} 发动【天香】将伤害转移给 ${this.nameOf(to)}`, 'skill');
                await this.damage({ source, target: to, amount, nature, card, noTianxiang: true });
                this.drawCards(to, Math.max(0, to.maxHp - to.hp), '天香');
                return 0;
              }
            }
          }
        }
      }
      // 地契：受到伤害时，可以弃置此牌防止本次伤害（离开防具栏即销毁）
      if (this.ddzMode && target.equips.armor && target.equips.armor.name === 'diqi') {
        const dq = await this.askOption(target, '【地契】：是否弃置此牌，防止本次伤害？', ['yes', 'no'], ['发动', '不发动']);
        if (dq === 'yes') {
          const card = target.equips.armor;
          target.equips.armor = null;
          this.destroyCard(card);
          this.log(`${this.nameOf(target)} 发动【地契】防止了本次伤害`, 'skill');
          this.emit();
          return 0;
        }
      }
      let amt = amount;
      // 藤甲：火焰伤害 +1；白银狮子：伤害至多 1
      if (target.equips.armor) {
        const an = target.equips.armor.name;
        if (an === 'tengjia' && nature === 'fire') { amt += 1; this.log('【藤甲】火焰伤害 +1', 'info'); }
        if (an === 'baiyinshizi' && amt > 1) { amt = 1; this.log('【白银狮子】将伤害减至 1 点', 'info'); }
      }
      // 夷灭（司马师）：造成伤害时可失去 1 点体力令伤害 +X，伤害后目标回复 X
      let yimieHeal = 0;
      if (source && source.alive && target !== source && source.skills.includes('j_yimie')) {
        source.flags = source.flags || {};
        const x = Math.max(0, target.hp - amt);
        if (x > 0 && source.flags.yimieTurn !== this.turnCount) {
          const r = await this.askOption(source, `【夷灭】：是否失去 1 点体力，令此伤害 +${x}（造成伤害后目标回复 ${x} 点）？`, ['yes', 'no'], ['发动', '放弃']);
          if (r === 'yes') {
            source.flags.yimieTurn = this.turnCount;
            await this.loseHp(source, 1, '夷灭');
            if (source.alive) { amt += x; yimieHeal = x; }
          }
        }
      }
      target.hp -= amt;
      // 本回合造成过伤害（诛害/袭爵等“结束阶段”判定用）：只记录当前回合角色在其自己回合内造成的伤害
      if (source && source.alive && this.currentSeat === source.seat) {
        source.flags = source.flags || {};
        source.flags.dealtDamage = true;
        source.flags.damageCount = (source.flags.damageCount || 0) + amt;
      }
      this.stats.damage[source ? source.seat : -1] = (this.stats.damage[source ? source.seat : -1] || 0) + amt;
      this.log(`${source ? this.nameOf(source) + ' 对 ' : ''}${this.nameOf(target)} 造成 ${amt} 点${nature === 'thunder' ? '雷电' : nature === 'fire' ? '火焰' : ''}伤害${card ? '（' + (CARDS[card.name] ? CARDS[card.name].name : card.name) + '）' : ''}`, 'damage');
      this.recent.push({ kind: 'damage', seat: target.seat, amount: amt, nature });
      this.emit();
      await this.pause(180);
      // 濒死/阵亡结算优先于“受到伤害后”技能：
      // 先求桃（可能被救回），未救回则阵亡；已阵亡角色不得再发动任何技能。
      if (target.hp <= 0 && target.alive) await this.dying(target, source);
      if (target.hp <= 0 && target.alive && !target.flags.buquSafe) await this.kill(target, source);
      if (yimieHeal > 0 && target.alive && !this.over) await this.recover(target, yimieHeal, source, '夷灭');
      // 此时仍存活（未致死 / 被救回 / 不屈）才结算自身“受到伤害后”技能；
      // 伤害来源与第三方的触发在 afterDamage 内单独处理，不要求目标存活。
      await this.afterDamage(source, target, amt, card, nature);
      this.checkWin();
      // 铁索连环：属性伤害在横置角色间传导；无论是否有其他横置角色，
      // 受到属性伤害的横置角色都应在本轮结算后重置（官方“横置→重置”）。
      if (!opts.chain && nature !== 'normal' && target.chained && !this.over) {
        const chained = this.alivePlayers.filter((q) => q.chained);
        const others = chained.filter((q) => q !== target);
        if (others.length) this.log('【铁索连环】属性伤害开始传导', 'info');
        // 先把所有横置角色重置，避免递归传导/二次触发
        chained.forEach((q) => { q.chained = false; });
        target.chained = false;
        for (const q of others) {
          if (!q.alive) continue;
          await this.damage({ source, target: q, amount: amt, nature, card, chain: true });
        }
      }
      return amt;
    }

    // 激将（界刘备）：其他蜀势力角色于其回合外使用/打出/替主公使用【杀】后，可令主公摸一张牌（每回合限一次）
    async jijiangReward(ally) {
      if (!ally || !ally.alive) return;
      const lord = this.lord;
      if (!lord || !lord.alive || lord.seat === ally.seat) return;
      if (!lord.skills || !lord.skills.includes('j_jijiang')) return;
      if (ally.kingdom !== '蜀') return;
      if (this.currentSeat === ally.seat) return; // 仅“于其回合外”
      lord.flags = lord.flags || {};
      if (lord.flags.jijiangTurn === this.turnCount) return;
      const r = await this.askOption(ally, `【激将】：是否令主公 ${this.nameOf(lord)} 摸一张牌？`, ['yes', 'no'], ['发动', '放弃']);
      if (r === 'yes') {
        lord.flags.jijiangTurn = this.turnCount;
        this.drawCards(lord, 1, '激将');
        this.log(`${this.nameOf(ally)} 响应【激将】，${this.nameOf(lord)} 摸一张牌`, 'skill');
        this.emit();
      }
    }

    // 护驾（曹操 Po，主公技）：其他魏势力角色于其回合外使用/打出【闪】后，可令主公摸一张（每回合一次）
    async hujiaReward(ally) {
      if (!ally || !ally.alive) return;
      const lord = this.lord;
      if (!lord || !lord.alive || lord.seat === ally.seat) return;
      if (!lord.skills || !lord.skills.includes('j_hujia')) return;
      if (ally.kingdom !== '魏') return;
      if (this.currentSeat === ally.seat) return; // 仅于其回合外
      lord.flags = lord.flags || {};
      if (lord.flags.hujiaTurn === this.turnCount) return;
      const r = await this.askOption(ally, `【护驾】：是否令主公 ${this.nameOf(lord)} 摸一张牌？`, ['yes', 'no'], ['发动', '放弃']);
      if (r === 'yes') {
        lord.flags.hujiaTurn = this.turnCount;
        this.drawCards(lord, 1, '护驾');
        this.log(`${this.nameOf(ally)} 响应【护驾】，${this.nameOf(lord)} 摸一张牌`, 'skill');
        this.emit();
      }
    }

    // 谦逊（陆逊 Po）：所有手牌移出游戏直到回合结束
    async qianxunExile(p) {
      if (!p || !p.alive || !p.hand.length) return false;
      const r = await this.askOption(p, '【谦逊】：是否将所有手牌移出游戏直到回合结束？', ['yes', 'no'], ['发动', '不发动']);
      if (r !== 'yes') return false;
      p.marks = p.marks || {};
      p.marks.exile = (p.marks.exile || []).concat(p.hand);
      p.hand = [];
      this.log(`${this.nameOf(p)} 发动【谦逊】，将手牌移出游戏直到回合结束`, 'skill');
      this.emit();
      return true;
    }

    async returnExile() {
      for (const q of this.players) {
        if (!q.marks || !Array.isArray(q.marks.exile) || !q.marks.exile.length) continue;
        const cards = q.marks.exile;
        q.marks.exile = [];
        if (q.alive) { q.hand.push(...cards); this.log(`${this.nameOf(q)} 的【谦逊】手牌移回`, 'skill'); }
        else this.toDiscard(cards);
      }
      this.emit();
    }

    // 冲阵（SP 赵云）：发动龙胆时，可获得对方一张手牌
    async chongzhenGain(p, opponent) {
      if (!p || !p.alive || !p.skills || !p.skills.includes('j_chongzhen')) return;
      if (!opponent || !opponent.alive || !opponent.hand.length) return;
      const r = await this.askOption(p, `【冲阵】：是否获得 ${this.nameOf(opponent)} 的一张手牌？`, ['yes', 'no'], ['发动', '放弃']);
      if (r !== 'yes') return;
      const c = opponent.hand[this.rand(opponent.hand.length)];
      if (!c) return;
      opponent.hand = opponent.hand.filter((x) => x.id !== c.id);
      p.hand.push(c);
      this.afterCardGain(p, [c]);
      this.log(`${this.nameOf(p)} 发动【冲阵】获得 ${this.nameOf(opponent)} 一张手牌`, 'skill');
      this.emit();
    }

    async afterDamage(source, target, amount, card, nature) {
      if (this.over) return;
      // 受伤害角色自身的“受到伤害后”技能：仅在其存活（未因本次伤害阵亡）时触发。
      // 致命伤害的流程为：伤害 → 濒死求桃 → 未救回则 kill(alive=false) → 才轮到受伤后技能。
      if (target.alive) await this.afterDamageSelf(target, source, amount, card, nature);
      // —— 伤害来源 / 第三方的“造成伤害后”技能：不要求目标存活 ——
      // 狂骨：伤害来源对距离 1 内角色造成伤害后回复 1 点
      if (source && source.alive && !source.flags.noSkills && source.skills.includes('kuanggu') && this.distance(source, target) <= 1) {
        await this.recover(source, 1, source, '狂骨');
      }
      // 趫猛（公孙瓒）：使用【杀】造成伤害后，可弃置目标区域里的一张牌；若为坐骑牌则获得之
      if (source && source.alive && target.alive && source.skills.includes('qiaomeng') && card && ['sha', 'huosha', 'leisha'].includes(card.name)) {
        const r = await this.askOption(source, `【趫猛】：是否弃置 ${this.nameOf(target)} 区域里的一张牌？`, ['yes', 'no'], ['发动', '放弃']);
        if (r === 'yes') {
          const picked = await this.pickCardFrom(target, source, { zones: ['hand', 'equip', 'judge'], reason: '趫猛：弃置其区域里的一张牌' });
          if (picked) {
            if (picked.type === 'equip' && ['offhorse', 'defhorse'].includes(picked.subtype)) {
              this.gainSpecific(source, picked);
              this.log(`${this.nameOf(source)} 发动【趫猛】获得 ${this.nameOf(target)} 的坐骑 ${this.cardText(picked)}`, 'skill');
            } else {
              this.toDiscard([picked]);
              await this.afterLoseCards(target, [picked]);
              this.log(`${this.nameOf(source)} 发动【趫猛】弃置 ${this.nameOf(target)} 的 ${this.cardText(picked)}`, 'skill');
            }
            this.emit();
          }
        }
      }
      // 利驭（吕布 Po）：杀造成伤害后获得其区域一张牌；非装备其摸一张，装备则视为对另一方使用决斗
      if (source && source.alive && target.alive && source.skills.includes('j_liyu') && card && ['sha', 'huosha', 'leisha'].includes(card.name)) {
        const r = await this.askOption(source, `【利驭】：是否获得 ${this.nameOf(target)} 区域里的一张牌？`, ['yes', 'no'], ['发动', '放弃']);
        if (r === 'yes') {
          const picked = await this.pickCardFrom(target, source, { zones: ['hand', 'equip', 'judge'], reason: '利驭：获得其区域里的一张牌' });
          if (picked) {
            this.gainSpecific(source, picked);
            this.log(`${this.nameOf(source)} 发动【利驭】获得 ${this.nameOf(target)} 的 ${this.cardText(picked)}`, 'skill');
            if (picked.type !== 'equip') {
              this.drawCards(target, 1, '利驭');
              this.log(`${this.nameOf(target)} 因【利驭】摸一张牌`, 'skill');
            } else {
              const cands = this.alivePlayers.filter((q) => q.seat !== source.seat && q.seat !== target.seat).map((q) => q.seat);
              if (cands.length) {
                const ts = await this.ask(target, { type: 'chooseTargets', player: target, reason: '利驭：选择另一名角色，吕布视为对其使用【决斗】', candidates: cands, min: 1, max: 1 });
                const victim = ts && this.players[ts[0]];
                if (victim && victim.alive) {
                  const vc = { id: -24, name: 'juedou', type: 'trick', subtype: null, nature: 'normal', suit: 'none', rank: 0, color: 'none', cards: [] };
                  this.table.push(vc);
                  await this.resolveDuel(source, vc, victim);
                  this.table = this.table.filter((c) => c !== vc);
                }
              }
            }
            this.emit();
          }
        }
      }
      // 潜心（徐庶，觉醒技）：造成伤害后若已受伤，减少 1 点体力上限并获得“荐言”
      if (source && source.alive && !source.flags.noSkills && source.skills.includes('qianxin') && !source.once.qianxin && source.hp < source.maxHp) {
        const r = await this.askOption(source, '【潜心】：是否发动觉醒技——减少 1 点体力上限并获得“荐言”？', ['yes', 'no'], ['发动', '不发动']);
        if (r === 'yes') {
          source.once.qianxin = true;
          source.skills = source.skills.filter((s) => s !== 'qianxin');
          if (!source.skills.includes('jianyan')) source.skills.push('jianyan');
          source.maxHp = Math.max(1, source.maxHp - 1);
          if (source.hp > source.maxHp) source.hp = source.maxHp;
          this.log(`${this.nameOf(source)} 发动【潜心】觉醒，体力上限 -1，获得【荐言】`, 'skill');
          this.emit();
        }
      }
      // 悲歌：任意角色受到【杀】伤害后，蔡文姬可发动
      if (card && ['sha', 'huosha', 'leisha'].includes(card.name)) {
        for (const q of this.alivePlayers) {
          if (!q.skills.includes('beige') || q.flags.noSkills) continue;
          if (!this.selectableCards(q).length) continue;
          const r = await this.askOption(q, `【悲歌】：是否弃一张牌令 ${this.nameOf(target)} 判定？`, ['yes', 'no'], ['发动', '放弃']);
          if (r !== 'yes') continue;
          const sel = await this.ask(q, { type: 'chooseCards', player: q, reason: '悲歌：弃置一张牌', cards: this.selectableCards(q), min: 1, max: 1 });
          if (!sel || !sel.length) continue;
          const moved = this.removeAnyCard(q, sel[0].id);
          if (moved) { this.toDiscard([moved]); this.afterLoseCards(q, [moved]); }
          const j = await this.judge(target, '悲歌');
          const su = j.card.suit;
          if (su === 'heart') await this.recover(target, 1, q, '悲歌');
          else if (su === 'diamond') this.drawCards(target, 2, '悲歌');
          else if (su === 'club' && source && source.alive) {
            // 由伤害来源选择弃置两张牌（手牌或装备）
            const pool = this.selectableCards(source);
            const n = Math.min(2, pool.length);
            if (n > 0) {
              const sel = await this.ask(source, { type: 'chooseCards', player: source, reason: `悲歌：弃置 ${n} 张牌`, cards: pool, min: n, max: n });
              const picked = (sel || []).slice(0, n).map((x) => this.removeAnyCard(source, x.id)).filter(Boolean);
              this.toDiscard(picked);
              await this.afterLoseCards(source, picked);
              this.log(`${this.nameOf(source)} 因【悲歌】弃置 ${picked.length} 张牌`, 'skill');
            }
          } else if (su === 'spade' && source && source.alive) source.flipped = true;
        }
      }
      // 暴虐：群势力角色造成伤害后，可由该角色令董卓判定，黑桃则回复 1 点
      const blord = this.lord;
      if (source && source.alive && !source.flags.noSkills && source.kingdom === '群' && blord && blord.alive && blord.skills.includes('baonue') && blord.seat !== source.seat) {
        const r = await this.askOption(source, '【暴虐】：是否令主公董卓判定，若为黑桃则其回复 1 点体力？', ['yes', 'no'], ['发动', '放弃']);
        if (r === 'yes') {
          const j = await this.judge(blord, '暴虐');
          if (j.card.suit === 'spade') await this.recover(blord, 1, blord, '暴虐');
        }
      }
    }

    // 受伤害角色自身的“受到伤害后”技能：仅在存活（未因本次伤害阵亡）时调用
    async afterDamageSelf(target, source, amount, card, nature) {
      if (!target.alive) return;
      // 奸雄：获得造成伤害的牌（虚拟多牌如“两张当万箭”应获得全部实体牌）
      if (!target.flags.noSkills && (target.skills.includes('jianxiong') || target.skills.includes('j_jianxiong')) && card) {
        const phys = (Array.isArray(card.cards) && card.cards.length) ? card.cards.filter(Boolean) : [card];
        const holder = this.table.find((t) => Array.isArray(t.cards) && t.cards.some((x) => phys.includes(x)));
        const gain = phys.filter((c) => (holder && holder.cards.includes(c)) || this.discardPile.some((x) => x.id === c.id));
        if (gain.length) {
          const res = await this.ask(target, {
            type: 'chooseOption', player: target, reason: '是否发动【奸雄】获得造成伤害的牌？',
            options: [{ id: 'yes', label: '获得' }, { id: 'no', label: '放弃' }],
          });
          if (res === 'yes') {
            if (target.skills.includes('j_jianxiong')) this.drawCards(target, 1, '奸雄');
            for (const c of gain) {
              if (holder && Array.isArray(holder.cards)) holder.cards = holder.cards.filter((x) => x !== c);
              this.discardPile = this.discardPile.filter((x) => x.id !== c.id);
              this.table = this.table.filter((t) => t !== c);
              target.hand.push(c);
            }
            if (holder && Array.isArray(holder.cards) && holder.cards.length === 0) holder.keep = true;
            this.afterCardGain(target, gain);
            this.log(`${this.nameOf(target)} 发动【奸雄】获得 ${gain.map((c) => this.cardText(c)).join('、')}`, 'skill');
            this.emit();
          }
        }
      }
      // 反馈（司马懿 Po）：每受到 1 点伤害后，可获得伤害来源一张牌
      if (!target.flags.noSkills && target.skills.includes('j_fankui') && source && source.alive) {
        const points = Math.max(1, Number(amount) || 1);
        for (let i = 0; i < points && target.alive && source.alive; i++) {
          if (!this.allCardsOf(source).length) break;
          const res = await this.ask(target, {
            type: 'chooseOption', player: target, reason: `【反馈】：是否获得伤害来源的一张牌？（${i + 1}/${points}）`,
            options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
          });
          if (res !== 'yes') break;
          const picked = await this.pickCardFrom(source, target, { zones: ['hand', 'equip'], reason: '反馈：选择一张牌获得' });
          if (picked) {
            this.gainSpecific(target, picked);
            this.log(`${this.nameOf(target)} 发动【反馈】获得 ${this.nameOf(source)} 一张牌`, 'skill');
            this.emit();
          }
        }
      }
      // 反馈：获得伤害来源一张牌
      if (!target.flags.noSkills && target.skills.includes('fankui') && source && source.alive && this.allCardsOf(source).length > 0) {
        const res = await this.ask(target, {
          type: 'chooseOption', player: target, reason: '是否发动【反馈】获得伤害来源的一张牌？',
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
        });
        if (res === 'yes') {
          const picked = await this.pickCardFrom(source, target, { zones: ['hand', 'equip'], reason: '反馈：选择一张牌获得' });
          if (picked) {
            this.gainSpecific(target, picked);
            this.log(`${this.nameOf(target)} 发动【反馈】获得 ${this.nameOf(source)} 一张牌`, 'skill');
            this.emit();
          }
        }
      }
      // 刚烈（夏侯惇 Po）：判定红色→伤害来源 1 点；黑色→弃置其一张牌
      if (!target.flags.noSkills && target.skills.includes('j_ganglie') && source && source.alive) {
        const res = await this.ask(target, {
          type: 'chooseOption', player: target, reason: '是否发动【刚烈】？',
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
        });
        if (res === 'yes') {
          const j = await this.judge(target, '刚烈');
          if (j.card.color === 'red') {
            this.log(`【刚烈】判定为红色，对 ${this.nameOf(source)} 造成 1 点伤害`, 'skill');
            await this.damage({ source: target, target: source, amount: 1, reason: '刚烈' });
          } else {
            const c = await this.pickCardFrom(source, target, { zones: ['hand', 'equip', 'judge'], reason: '刚烈：弃置其一张牌' });
            if (c) { this.toDiscard([c]); await this.afterLoseCards(source, [c]); this.log(`${this.nameOf(target)} 因【刚烈】弃置 ${this.nameOf(source)} 一张牌`, 'skill'); }
          }
        }
      }
      // 刚烈
      if (!target.flags.noSkills && target.skills.includes('ganglie') && source && source.alive) {
        const res = await this.ask(target, {
          type: 'chooseOption', player: target, reason: '是否发动【刚烈】？',
          options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
        });
        if (res === 'yes') {
          const j = await this.judge(target, '刚烈');
          if (j.card.suit !== 'heart') {
            const opt = await this.ask(source, {
              type: 'chooseOption', player: source, reason: '【刚烈】：请选择弃置两张手牌或受到 1 点伤害',
              options: source.hand.length >= 2 ? [{ id: 'discard', label: '弃置两张手牌' }, { id: 'damage', label: '受到 1 点伤害' }] : [{ id: 'damage', label: '受到 1 点伤害' }],
            });
            if (opt === 'discard' && source.hand.length >= 2) {
              const sel = await this.ask(source, { type: 'chooseCards', player: source, reason: '刚烈：弃置两张手牌', cards: source.hand.slice(), min: 2, max: 2, from: 'hand' });
              const moved = this.removeFromHand(source, (sel || []).slice(0, 2).map((c) => c.id));
              this.toDiscard(moved);
              this.afterLoseCards(source, moved);
              this.log(`${this.nameOf(source)} 因【刚烈】弃置两张手牌`, 'skill');
            } else {
              await this.damage({ source: target, target: source, amount: 1, reason: '刚烈' });
            }
          } else {
            this.log(`【刚烈】判定为红桃，未生效`, 'skill');
          }
        }
      }
      // 遗计（郭嘉 Po）：摸两张，然后可交给至多两名其他角色共计至多两张手牌
      if (!target.flags.noSkills && target.skills.includes('j_yiji') && target.alive) {
        const points = Math.max(1, Number(amount) || 1);
        for (let i = 0; i < points && target.alive; i++) {
          const res = await this.ask(target, {
            type: 'chooseOption', player: target, reason: '是否发动【遗计】摸两张牌，然后交给至多两名其他角色共计至多两张手牌？',
            options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
          });
          if (res !== 'yes') break;
          const drawn = this.drawCards(target, 2, '遗计');
          const sel = await this.ask(target, { type: 'chooseCards', player: target, reason: '遗计：选择至多两张牌交给其他角色', cards: drawn, min: 0, max: Math.min(2, drawn.length) });
          const chosen = (sel || []).slice(0, 2).map((x) => this.findCard(target, x.id)).filter(Boolean);
          if (chosen.length) {
            const others = this.alivePlayers.filter((q) => q.seat !== target.seat).map((q) => q.seat);
            if (others.length) {
              const ts = await this.ask(target, { type: 'chooseTargets', player: target, reason: '遗计：选择交给的角色', candidates: others, min: 1, max: Math.min(2, chosen.length) });
              const seats = (ts || []).slice(0, Math.min(2, chosen.length));
              for (let k = 0; k < chosen.length && seats.length; k++) {
                const q = this.players[seats[k % seats.length]];
                const c = chosen[k];
                if (!q || !q.alive || !c) continue;
                target.hand = target.hand.filter((x) => x.id !== c.id);
                q.hand.push(c);
                this.afterCardGain(q, [c]);
              }
              this.log(`${this.nameOf(target)} 发动【遗计】交给 ${seats.map((s2) => this.nameOf(this.players[s2])).join('、')} ${chosen.length} 张牌`, 'skill');
            }
          }
          this.emit();
        }
      }
      // 遗计：每受到 1 点伤害后触发一次
      if (!target.flags.noSkills && target.skills.includes('yiji') && target.alive) {
        const points = Math.max(1, Number(amount) || 1);
        for (let i = 0; i < points && target.alive; i++) {
          const res = await this.ask(target, {
            type: 'chooseOption', player: target, reason: '是否发动【遗计】摸两张牌并分配给任意角色？',
            options: [{ id: 'yes', label: '发动' }, { id: 'no', label: '放弃' }],
          });
          if (res !== 'yes') break;
          const drawn = this.drawCards(target, 2, '遗计');
          await this.distributeCards(target, drawn, '遗计：分配这两张牌');
          this.log(`${this.nameOf(target)} 发动【遗计】`, 'skill');
          this.emit();
        }
      }
      // 节命/放逐/新生等（skills.js 的 skillAfterDamage）
      await this.skillTrigger('afterDamage', target, { source, amount, card, nature });
    }

    async dying(p, source) {
      if (!p.alive || p.hp > 0) return;
      // 涅槃（限定技）：只有实际发动才消耗，选择“不发动”不消耗
      if (p.skills.includes('niepan') && !p.once.niepan) {
        const r = await this.askOption(p, '是否发动【涅槃】？弃置所有牌，复原武将牌，摸三张牌，回复至 3 点体力', ['yes', 'no'], ['发动涅槃', '不发动']);
        if (r === 'yes') {
          p.once.niepan = true;
          const all = [...p.hand, ...Object.values(p.equips).filter(Boolean), ...p.judges];
          p.hand = []; p.judges = [];
          for (const k of Object.keys(p.equips)) p.equips[k] = null;
          this.toDiscard(all);
          p.hp = Math.min(p.maxHp, 3);
          p.flipped = false; p.chained = false;
          this.drawCards(p, 3, '涅槃');
          this.log(`${this.nameOf(p)} 发动【涅槃】`, 'skill');
          this.emit();
          return;
        }
      }
      // 不屈
      if (p.skills.includes('buqu')) {
        const existing = p.marks.buqu || [];
        const ranks = new Set(existing.map((c) => c.rank));
        let safe = true;
        while (p.hp <= 0) {
          if (this.deck.length === 0) this.reshuffle();
          const c = this.deck.pop(); if (!c) break;
          // 点数与已有「不屈」牌相同：此牌进弃牌堆，不留在不屈区
          if (ranks.has(c.rank)) { safe = false; this.toDiscard([c]); break; }
          existing.push(c);
          ranks.add(c.rank);
          if (existing.length >= 13) break;
          this.log(`${this.nameOf(p)} 的「不屈」牌：${this.cardText(c)}`, 'skill');
          break;
        }
        p.marks.buqu = existing;
        if (safe && p.hp <= 0) {
          p.flags.buquSafe = true;
          this.log(`${this.nameOf(p)} 因【不屈】暂缓死亡`, 'skill');
          this.emit();
          return;
        }
      }
      this.log(`${this.nameOf(p)} 进入濒死状态，需要 ${1 - p.hp} 个【桃】`, 'dying');
      this.emit();
      let guard = 0;
      while (p.hp <= 0 && p.alive && guard++ < 30) {
        let saved = false;
        for (const q of this.aliveOrder(this.currentSeat, true)) {
          if (p.hp > 0) break;
          const need = 1 - p.hp;
          this.recent.push({ kind: 'rescue', seat: q.seat, dyingSeat: p.seat, phase: 'ask' });
          if (this.recent.length > 200) this.recent.shift();
          this.emit();
          const peach = await this.askForPeach(q, p);
          this.recent.push({ kind: 'rescue', seat: q.seat, dyingSeat: p.seat, phase: peach ? 'save' : 'pass' });
          if (this.recent.length > 200) this.recent.shift();
          this.emit();
          if (!peach) await this.pause(220);
          if (peach) {
            let heal = 1;
            // 聚众：酒当桃时，弃同名【酒】令回复量 +1
            if (peach.usedName === 'jiu' && this.ddzMode && q.role === 'farmer') {
              const holder = await this.juzhongEnhance(q, 'jiu');
              if (holder) { heal += 1; this.log(`${this.nameOf(holder)} 发动【聚众】令此【酒】回复量 +1`, 'skill'); }
            }
            // 救援：其他吴势力角色对主公使用【桃】时多回复 1 点
            if (p.skills.includes('jiuyuan') && p.role === 'lord' && q.kingdom === '吴' && q.seat !== p.seat) heal += 1;
            p.hp = Math.min(p.maxHp, p.hp + heal);
            this.log(`${this.nameOf(q)} 使用【桃】救起 ${this.nameOf(p)}`, 'heal');
            this.emit();
            // 聚众：桃生效后，使用者摸两张牌
            if (peach.usedName === 'tao' && this.ddzMode && q.role === 'farmer') {
              const holder = await this.juzhongEnhance(q, 'tao');
              if (holder) { this.drawCards(q, 2, '聚众'); this.log(`${this.nameOf(holder)} 发动【聚众】令 ${this.nameOf(q)} 摸两张牌`, 'skill'); }
            }
            saved = true;
          }
        }
        if (!saved) break;
      }
      if (p.hp <= 0) {
        this.log(`${this.nameOf(p)} 濒死未被救回`, 'dying');
      }
      this.emit();
    }

    async kill(p, source) {
      if (!p.alive) return;
      p.alive = false;
      p.revealed = true;
      p.deathTurn = this.turnCount;
      this.log(`${this.nameOf(p)} 阵亡（身份：${this.roleName(p.role)}）`, 'death');
      await this.skillTrigger('onDeath', p, { killer: source, dead: p });
      for (const q of this.alivePlayers) { if (q.seat !== p.seat && q.skills.includes('xingshang')) await this.skillXingshang(q, p); }
      this.recent.push({ kind: 'death', seat: p.seat });
      this.emit();
      // 奖惩（单挑无奖惩）
      if (this.mode !== '1v1' && !this.teamMode && !this.ddzMode && source && source.alive && source.seat !== p.seat) {
        if (p.role === 'rebel') {
          this.drawCards(source, 3, '击杀反贼奖励');
          this.log(`${this.nameOf(source)} 击杀反贼，摸三张牌`, 'reward');
        } else if (p.role === 'loyalist' && source.role === 'lord') {
          const cards = [...source.hand, ...Object.values(source.equips).filter(Boolean)];
          source.hand = [];
          for (const k of Object.keys(source.equips)) source.equips[k] = null;
          this.toDiscard(cards);
          this.log(`主公误杀忠臣，弃置所有手牌和装备`, 'punish');
        }
      }
      // 阵亡时弃置所有牌（地契离装销毁，不进弃牌堆）
      const allRest = [...p.hand, ...Object.values(p.equips).filter(Boolean), ...p.judges];
      p.hand = []; p.judges = [];
      for (const k of Object.keys(p.equips)) p.equips[k] = null;
      const diqi = allRest.filter((c) => c && c.name === 'diqi');
      diqi.forEach((c) => this.destroyCard(c));
      this.toDiscard(allRest.filter((c) => !c || c.name !== 'diqi'));
      this.emit();
      this.checkWin();
    }

    checkWin() {
      if (this.over) return;
      const alive = this.alivePlayers;
      if (this.ddzMode) {
        const lord = this.players.find((p) => p.role === 'landlord');
        // 原版斗地主：任意角色阵亡则结束；地主阵亡=农民胜，否则地主胜
        if (this.players.some((p) => !p.alive)) {
          const w = (lord && !lord.alive) ? 'farmer' : 'landlord';
          this.endGame(w, (w === 'farmer' ? '农民获胜！' : '地主获胜！') + (this.ddzMultiplier ? ' · 倍率 ×' + this.ddzMultiplier : ''));
        }
        return;
      }
      if (this.teamMode) {
        const teams = new Set(alive.map((p) => p.role));
        if (teams.size <= 1) {
          const w = teams.values().next().value || 'team0';
          this.endGame(w, `${this.teamName(w)}获胜！`);
        }
        return;
      }
      if (this.mode === '1v1') {
        if (alive.length <= 1) {
          const w = alive[0];
          this.endGame(w ? w.role : 'rebel', `${w ? this.nameOf(w) : '胜者'}获胜！`);
        }
        return;
      }
      const lord = this.lord;
      const rebels = alive.filter((p) => p.role === 'rebel');
      const renegade = alive.filter((p) => p.role === 'renegade');
      const loyal = alive.filter((p) => p.role === 'loyalist');
      if (!lord.alive) {
        if (renegade.length === 1 && alive.length === 1) {
          this.endGame('renegade', '内奸获胜！');
        } else {
          this.endGame('rebel', '反贼获胜！');
        }
        return;
      }
      if (rebels.length === 0 && renegade.length === 0) {
        this.endGame('lord', '主公与忠臣获胜！');
      }
    }

    endGame(side, text) {
      if (this.over) return;
      this.over = true;
      this.winner = side;
      this.winText = text;
      this.log(text, 'system');
      this.emit();
    }

    surrender(seat) {
      if (this.over) return;
      const p = this.players[seat];
      let winner;
      if (this.ddzMode) winner = p.role === 'landlord' ? 'farmer' : 'landlord';
      else if (this.teamMode) winner = p.role === 'team0' ? 'team1' : 'team0';
      else if (this.mode === '1v1') winner = this.players[seat === 0 ? 1 : 0].role;
      else if (p.role === 'lord' || p.role === 'loyalist') winner = 'rebel';
      else if (p.role === 'rebel') winner = 'lord';
      else winner = 'lord';
      this.over = true;
      this.winner = winner;
      this.winText = `${p ? this.nameOf(p) : '玩家'} 投降`;
      this.log(this.winText, 'system');
      this.emit();
    }

    roleName(r) { return { lord: '主公', loyalist: '忠臣', rebel: '反贼', renegade: '内奸', team0: '蓝队', team1: '红队', landlord: '地主', farmer: '农民' }[r] || r; }

    // ---------------- 距离 ----------------
    distance(from, to) {
      if (from.seat === to.seat) return 0;
      const alive = this.players.filter((p) => p.alive).sort((a, b) => a.seat - b.seat);
      const i = alive.indexOf(from), j = alive.indexOf(to);
      const n = alive.length;
      const raw = Math.min((j - i + n) % n, (i - j + n) % n);
      let d = raw;
      if (to.equips.defhorse) d += 1;
      if (from.equips.offhorse) d -= 1;
      if (from.skills.includes('mashu')) d -= 1;
      // 义从（公孙瓒）：你计算与其他角色的距离-1；若你的体力值不大于 2，其他角色计算与你的距离+1
      if (from.skills.includes('yicong')) d -= 1;
      if (to.skills.includes('yicong') && to.hp <= 2) d += 1;
      if (from.skills.includes('tuntian')) d -= (from.marks.tian || 0);
      return Math.max(1, d);
    }

    attackRange(p) {
      const w = p.equips.weapon;
      return Math.max(1, w ? w.range : 1);
    }

    inAttackRange(from, to) {
      return this.distance(from, to) <= this.attackRange(from);
    }

    // ---------------- 花色（红颜） ----------------
    // 红颜：小乔的黑桃牌视为红桃牌（手牌、装备区、判定牌均适用）
    suitOf(owner, card) {
      if (!card) return null;
      if (owner && owner.skills && owner.skills.includes('hongyan') && card.suit === 'spade') return 'heart';
      return card.suit;
    }
    colorOf(owner, card) {
      if (!card) return null;
      const s = this.suitOf(owner, card);
      if (s === 'spade' || s === 'club') return 'black';
      if (s === 'heart' || s === 'diamond') return 'red';
      return card.color;
    }
    effCard(owner, card) {
      if (!card) return card;
      const s = this.suitOf(owner, card);
      if (s === card.suit) return card;
      return Object.assign({}, card, { suit: s, color: this.colorOf(owner, card) });
    }

    // ---------------- 斗地主专属工具 ----------------
    // 构造一张卡牌对象（id 需由调用方保证不与牌堆冲突）
    makeCard(name, suit, rank, id) {
      const def = CARDS[name];
      if (!def) return null;
      return { id, name, suit, rank, type: def.type, subtype: def.subtype || null, range: def.range || 0, color: SUITS[suit].color, nature: def.nature || 'normal' };
    }
    // 销毁一张牌：从所有区域移除，不进入弃牌堆（地契“离装销毁”）
    destroyCard(card) {
      if (!card) return;
      const id = card.id;
      this.deck = (this.deck || []).filter((c) => c.id !== id);
      this.discardPile = (this.discardPile || []).filter((c) => c.id !== id);
      this.table = (this.table || []).filter((c) => c.id !== id);
      for (const p of this.players) {
        p.hand = p.hand.filter((c) => c.id !== id);
        p.judges = p.judges.filter((c) => c.id !== id);
        for (const k of Object.keys(p.equips || {})) if (p.equips[k] && p.equips[k].id === id) p.equips[k] = null;
      }
    }
    // 炸弹：底价加倍，不超过上限
    doubleDdzBase() {
      const before = this.ddzMultiplier || 1;
      this.ddzMultiplier = Math.min(before * 2, this.ddzMaxMultiple || 4);
      return this.ddzMultiplier;
    }
    // 聚众（斗地主农民）：队友使用基本牌时，弃一张同名基础牌强化；返回发动者或 null
    async juzhongEnhance(user, cardName) {
      if (!this.ddzMode || !user || user.role !== 'farmer') return null;
      if (!['sha', 'huosha', 'leisha', 'shan', 'tao', 'jiu'].includes(cardName)) return null;
      if (this.ddzFierce && cardName === 'tao') return null; // 鏖战：桃不能聚众/响应聚众
      const mates = this.alivePlayers.filter((q) => q.seat !== user.seat && q.role === 'farmer' && q.skills.includes('juzhong') && q.hand.some((c) => c.name === cardName));
      for (const q of mates) {
        const r = await this.askOption(q, `【聚众】：是否弃置一张【${CARDS[cardName].name}】，强化 ${this.nameOf(user)} 使用的此牌？`, ['yes', 'no'], ['发动', '不发动']);
        if (r !== 'yes') continue;
        const c = q.hand.find((x) => x.name === cardName);
        q.hand = q.hand.filter((x) => x !== c);
        this.toDiscard([c]);
        this.log(`${this.nameOf(q)} 发动【聚众】弃置 ${this.cardText(c)}`, 'skill');
        this.emit();
        return q;
      }
      return null;
    }
    // 聚众（闪）：响应生效后，弃置一名角色一张牌
    async juzhongAfterShan(user) {
      const holder = await this.juzhongEnhance(user, 'shan');
      if (!holder) return;
      const cands = this.alivePlayers.filter((q) => q.seat !== holder.seat && this.allCardsOf(q).length).map((q) => q.seat);
      if (!cands.length) return;
      const sel = await this.ask(holder, { type: 'chooseTargets', player: holder, reason: '聚众：选择一名角色弃置其一张牌', candidates: cands, min: 1, max: 1 });
      const t = sel && this.players[sel[0]];
      if (!t) return;
      const c = await this.pickCardFrom(t, holder, { zones: ['hand', 'equip', 'judge'], reason: '聚众：弃置一张牌' });
      if (c) {
        this.toDiscard([c]);
        await this.afterLoseCards(t, [c]);
        this.log(`${this.nameOf(holder)} 发动【聚众】弃置 ${this.nameOf(t)} 一张牌`, 'skill');
        this.emit();
      }
    }
    // 共济弃牌后的通用钩子（当前无额外效果，保留扩展点）
    async juzhongAfterDiscard() {}

    // ---------------- 卡牌文本 ----------------
    cardText(c) {
      if (!c) return '';
      if (c.id === -1) return '无';
      const s = SUITS[c.suit] || { cn: '◇', color: 'none' };
      const r = D.RANK_CN[c.rank] || c.rank;
      return `【${CARDS[c.name] ? CARDS[c.name].name : c.name}】${s.cn}${r}`;
    }

    // ---------------- 获得/失去牌 ----------------
    gainSpecific(p, card, log = false) {
      if (!card) return;
      this.discardPile = this.discardPile.filter((c) => c.id !== card.id);
      this.table = this.table.filter((c) => c.id !== card.id);
      p.hand.push(card);
      this.afterCardGain(p, [card]);
      if (log) this.log(`${this.nameOf(p)} 获得 ${this.cardText(card)}`, 'gain');
    }

    afterCardGain(p, cards) {
      // 获得牌后的异步技能钩子（清俭等）；保持 afterCardGain 同步语义，调用方无需 await
      if (!p || !p.alive || !cards || !cards.length) return;
      this.afterCardGainHook(p, cards).catch((e) => console.error(e));
    }

    afterLoseCards(p, cards, fromHand) {
      if (!p.alive) return;
      cards = (cards || []).filter(Boolean);
      if (!cards.length) return;
      // 连营：失去最后一张手牌
      if (!p.flags.noSkills && p.skills.includes('lianying') && p.hand.length === 0 && (fromHand || cards.some((c) => c.type !== 'equip'))) {
        this.drawCards(p, 1, '连营');
        this.log(`${this.nameOf(p)} 发动【连营】摸一张牌`, 'skill');
      }
      if (cards.some((c) => c.name === 'baiyinshizi') && p.alive && p.hp < p.maxHp) {
        this.recover(p, 1, null, '白银狮子');
      }
      this.afterLoseCardsHook(p, cards, fromHand).catch((e) => console.error(e));
      // 枭姬：失去装备
      const lostEquip = cards.filter((c) => c && (c.type === 'equip'));
      if (!p.flags.noSkills && p.skills.includes('xiaoji') && lostEquip.length > 0 && !this._xiaojiBusy) {
        this._xiaojiBusy = true;
        this.drawCards(p, 2 * lostEquip.length, '枭姬');
        this.log(`${this.nameOf(p)} 发动【枭姬】摸牌`, 'skill');
        this._xiaojiBusy = false;
      }
    }

    // 从目标处选一张牌（顺手/过拆/反馈/精囊）
    async pickCardFrom(target, chooser, opts = {}) {
      // 已阵亡角色既不能作为取牌目标，也不能再主动选牌
      if (!target || !chooser || !target.alive || !chooser.alive) return null;
      const zones = opts.zones || ['hand', 'equip', 'judge'];
      const choices = [];
      if (zones.includes('hand') && target.hand.length) choices.push({ zone: 'hand', count: target.hand.length });
      for (const k of ['weapon', 'armor', 'offhorse', 'defhorse']) {
        if (zones.includes('equip') && target.equips[k]) choices.push({ zone: 'equip', slot: k, card: target.equips[k] });
      }
      if (zones.includes('judge')) {
        for (const c of target.judges) choices.push({ zone: 'judge', card: c });
      }
      if (!choices.length) return null;
      if (!choices.length) return null;
      // 手牌区必须显示牌背，由玩家选择具体位置；其他区域仍走 chooseCardFrom
      if (choices.length === 1 && choices[0].zone === 'hand') {
        const idx = await this.ask(chooser, {
          type: 'chooseHiddenCard', player: chooser, target,
          count: target.hand.length, reason: opts.reason || '选择一张手牌',
        });
        if (idx == null || idx < 0 || idx >= target.hand.length) return null;
        const c = target.hand.splice(idx, 1)[0];
        this.recent.push({ kind: 'handReveal', seat: target.seat, card: { name: c.name, suit: c.suit, rank: c.rank, color: c.color }, reason: opts.reason || '选择手牌' });
        if (this.recent.length > 200) this.recent.shift();
        this.emit();
        return c;
      }
      const res = await this.ask(chooser, {
        type: 'chooseCardFrom', player: chooser, target, choices,
        reason: opts.reason || '选择一张牌',
      });
      if (!res) return null;
      if (res.zone === 'hand') {
        if (!target.hand.length) return null;
        const idx = await this.ask(chooser, {
          type: 'chooseHiddenCard', player: chooser, target,
          count: target.hand.length, reason: opts.reason || '选择一张手牌',
        });
        if (idx == null || idx < 0 || idx >= target.hand.length) return null;
        const c = target.hand.splice(idx, 1)[0];
        this.recent.push({ kind: 'handReveal', seat: target.seat, card: { name: c.name, suit: c.suit, rank: c.rank, color: c.color }, reason: opts.reason || '选择手牌' });
        if (this.recent.length > 200) this.recent.shift();
        this.emit();
        return c;
      }
      if (res.zone === 'equip') {
        // 奇才（黄月英 Po）：防止其他角色弃置你的防具
        if (res.slot === 'armor' && target.skills.includes('j_qicai') && chooser.seat !== target.seat && /弃置/.test(opts.reason || '')) {
          this.log(`【奇才】防止了 ${this.nameOf(target)} 的防具被弃置`, 'skill');
          return null;
        }
        const c = target.equips[res.slot];
        if (!c) return null;
        target.equips[res.slot] = null;
        if (c.name === 'diqi') { this.destroyCard(c); this.log('【地契】离开防具栏，销毁', 'info'); return null; }
        this.afterLoseCards(target, [c]);
        return c;
      }
      if (res.zone === 'judge') {
        const c = target.judges.find((x) => x.id === (res.cardId != null ? res.cardId : (res.card && res.card.id)));
        if (!c) return null;
        target.judges = target.judges.filter((x) => x.id !== c.id);
        return c;
      }
      return null;
    }

    async distributeCards(giver, cards, reason) {
      if (!cards.length) return;
      const res = await this.ask(giver, {
        type: 'distribute', player: giver, reason,
        // 已阵亡角色不能接收牌
        cards: cards.slice(), candidates: this.players.filter((p) => p.alive).map((p) => p.seat),
      });
      const plan = Array.isArray(res) ? res : [];
      const used = new Set();
      for (const item of plan) {
        const c = cards.find((x) => x.id === item.cardId);
        if (!c || used.has(c.id)) continue;
        used.add(c.id);
        const to = this.players[item.seat];
        if (!to || !to.alive) continue; // 死者不能获得牌
        giver.hand = giver.hand.filter((x) => x.id !== c.id);
        to.hand.push(c);
        this.afterCardGain(to, [c]);
      }
      for (const c of cards) {
        if (!used.has(c.id)) {
          giver.hand = giver.hand.filter((x) => x.id !== c.id);
          giver.hand.push(c);
        }
      }
      this.emit();
    }
  }

  global.SGS = global.SGS || {};
  global.SGS.Game = Game;
  global.SGS.MODES = MODES;
  global.SGS.sleep = sleep;
})(typeof window !== 'undefined' ? window : globalThis);
