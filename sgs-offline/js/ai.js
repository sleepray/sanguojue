/* 三国杀 · 单机版 — AI
 * 只使用公开信息 + 自身身份；对他人身份做简单推断（单机体验优先）。
 *
 * 设计要点：
 *  - 出牌：模板动作先按局面评分，再补全具体牌与目标；所有动作都带“资源守卫”，
 *    牌不够 / 没有合法目标时评分直接为 0，避免引擎早退造成的空转循环。
 *  - 响应：闪/杀按是否致命决定；桃按身份关系与主公优先级；无懈按“牌是否已生效”
 *    区分抵消与反抵消，不帮敌人抵消自己的伤害牌。
 *  - 目标：身份关系 > 距离/攻击范围 > 手牌数 > 残血/威胁度。
 *  - 难度：aiLevel = easy / normal / hard，默认 normal；不改变调用方。
 *    用法：new SGS.AI(game, seat, { level: 'hard' })（或 { aiLevel: 'hard' }）。
 *  - 决策随机数一律使用 game.rng()（随 seed 可复现）；只有动画延迟用 Math.random。
 */
(function (global) {
  'use strict';
  const SGS = global.SGS;
  const D = global.SGS_DATA;
  const { CARDS, SUITS } = D;

  const CARD_VALUE = { tao: 9, shan: 6, sha: 5, huosha: 6, leisha: 6, jiu: 5, wuzhong: 10, juedou: 5, shunshou: 8, guohe: 7, jiedao: 5, wuxie: 7, nanman: 6, wanjian: 6, taoyuan: 5, wugu: 7, lebu: 7, bingliang: 5, shandian: 3, tiesuo: 3, huogong: 4 };
  const EQUIP_VALUE = { zhugeliannu: 8, qinggang: 6, cixiong: 6, qinglong: 7, zhangba: 6, guanshi: 7, fangtian: 7, qilin: 6, hanbing: 6, gudingdao: 8, zhuque: 6, bagua: 8, renwang: 7, tengjia: 6, baiyinshizi: 7, chitu: 5, dawan: 5, zixing: 5, dilu: 6, jueying: 6, zhuahuang: 6, hualiu: 6 };

  // 常见强将威胁度（只影响“先打谁”，不影响契约）
  const GENERAL_THREAT = {
    吕布: 3, 关羽: 3, 张飞: 2.5, 黄忠: 2.5, 马超: 2.5, 甘宁: 2.5, 张辽: 2.5, 貂蝉: 2.5,
    周瑜: 2.5, 司马懿: 2.5, 郭嘉: 2.5, 华佗: 2.5, 孙尚香: 2.5, 孙权: 2, 曹操: 2, 董卓: 2.5,
    许褚: 2, 黄盖: 2, 太史慈: 2, 庞德: 2, 颜良文丑: 2, 张角: 2.5, 于吉: 2, 荀彧: 2, 鲁肃: 2,
    陆逊: 2, 吕蒙: 2, 曹丕: 2, 邓艾: 2, 姜维: 2.5, 孙策: 2.5, 袁绍: 2, 祝融: 2, 孟获: 2,
  };

  const DAMAGE_TRICKS = ['juedou', 'guohe', 'shunshou', 'lebu', 'bingliang', 'nanman', 'wanjian', 'huogong', 'jiedao'];
  const HARM_JUDGE = ['lebu', 'bingliang', 'shandian'];

  // 难度参数：normal 为调优主目标；easy 削弱，hard 略增强
  const LEVELS = {
    easy: { name: 'easy', threshold: 1.6, jitter: 2.0, shaRespond: 0.6, shanRespond: 0.8, peachFriend: 0.55, wuxie: 0.5, pindian: 'random', trackThreat: false },
    normal: { name: 'normal', threshold: 0.8, jitter: 0, shaRespond: 1, shanRespond: 1, peachFriend: 1, wuxie: 1, pindian: 'high', trackThreat: true },
    hard: { name: 'hard', threshold: 0.7, jitter: 0, shaRespond: 1, shanRespond: 1, peachFriend: 1, wuxie: 1, pindian: 'high', trackThreat: true },
  };

  const valueOf = (c) => c ? (c.type === 'equip' ? (EQUIP_VALUE[c.name] || 4) : (CARD_VALUE[c.name] || 3)) : 0;
  const byId = (arr, id) => (arr || []).find((c) => c && c.id === id) || null;

  class AI {
    constructor(game, seat, opts = {}) {
      this.game = game;
      this.seat = seat;
      this.speed = opts.speed == null ? 60 : opts.speed;
      this.levelName = opts.aiLevel || opts.level || 'normal';
      this.level = LEVELS[this.levelName] || LEVELS.normal;
      this._guhuoName = null;
    }
    get p() { return this.game.players[this.seat]; }
    get alive() { return this.game.alivePlayers; }
    rnd() { return this.game.rng(); }
    chance(rate) { return this.rnd() < rate; }
    async delay(mult) { if (this.speed) await SGS.sleep(Math.round(this.speed * (mult == null ? 1 : mult) + Math.random() * 40)); }

    async decide(req) {
      await this.delay(req.type === 'play' ? 1 : 0.55);
      switch (req.type) {
        case 'chooseGeneral': return this.chooseGeneral(req);
        case 'play': return this.choosePlay(req);
        case 'response': return this.chooseResponse(req);
        case 'chooseCards': return this.chooseCards(req);
        case 'chooseTargets': return this.chooseTargets(req);
        case 'chooseOption': return this.chooseOption(req);
        case 'chooseCardFrom': return this.chooseCardFrom(req);
        case 'arrange': return this.arrange(req);
        case 'pickFrom': return this.pickFrom(req);
        case 'chooseHiddenCard': return this.game.rand(Math.max(1, req.count || 1));
        case 'distribute': return this.distribute(req);
        default: return null;
      }
    }

    // ---------------- 身份关系 ----------------
    lordSeat() { return this.game.lordSeat; }
    relation(other) {
      if (!other) return 'neutral';
      const me = this.p;
      if (other.seat === me.seat) return 'self';
      // 团队/斗地主身份公开；身份局只认公开身份（主公/已揭示）
      if (this.game.teamMode || this.game.ddzMode) return me.role === other.role ? 'friend' : 'enemy';
      // 身份局只认公开身份：主公、已揭示；反贼也不互认
      let known = other.role === 'lord' || !!other.revealed;
      if (!known) return 'neutral';
      const aliveRebels = this.alive.filter((q) => q.role === 'rebel' && (q.revealed || q === me)).length;
      const aliveLoyal = this.alive.filter((q) => q.role === 'loyalist' && q.revealed).length;
      if (me.role === 'lord' || me.role === 'loyalist') {
        if (other.role === 'lord' || (other.revealed && other.role === 'loyalist')) return 'friend';
        if (other.revealed && other.role === 'rebel') return 'enemy';
        return 'neutral';
      }
      if (me.role === 'rebel') {
        if (other.role === 'lord' || (other.revealed && other.role === 'loyalist')) return 'enemy';
        if (other.revealed && other.role === 'rebel') return 'friend';
        return 'neutral';
      }
      // 内奸：只知道主公与已揭示角色；不按真实人数透视
      const lordCamp = aliveLoyal + (this.game.lord && this.game.lord.alive ? 1 : 0);
      if (other.role === 'lord') return aliveRebels > 0 ? 'friend' : 'enemy';
      if (other.revealed && other.role === 'loyalist') {
        if (aliveRebels === 0) return 'enemy';
        return lordCamp > aliveRebels ? 'enemy' : 'neutral';
      }
      if (other.revealed && other.role === 'rebel') {
        if (aliveRebels >= lordCamp) return 'enemy';
        return 'neutral';
      }
      return 'neutral';
    }

    isFriend(q) { const r = this.relation(q); return r === 'friend' || r === 'self'; }
    isEnemy(q) { return this.relation(q) === 'enemy'; }

    threatOf(q) {
      if (!q) return 0;
      if (!this.level.trackThreat) return 0;
      let t = GENERAL_THREAT[q.general ? q.general.name : ''] || 0;
      if (q.hp >= 3) t += 0.5;
      if (q.hand.length >= 4) t += 0.5;
      if (q.role === 'lord') t += 1;
      return t;
    }

    // 通用目标评分：身份关系 + 残血 + 手牌 + 威胁度；distance 作为同分时的排序参考
    scoreTarget(other) {
      if (!other) return 0;
      const rel = this.relation(other);
      let s = 0;
      if (rel === 'enemy') s += 30;
      else if (rel === 'friend') s -= 30;
      else if (rel === 'self') s -= 200;
      s += (other.maxHp - other.hp) * 2;
      s += Math.max(0, 4 - other.hp) * 5;
      if (other.hand.length === 0) s += 12;
      if (other.role === 'lord') s += 10;
      if (other.hp <= 1) s += 8;
      s += this.threatOf(other) * 1.5;
      return s;
    }
    healNeed(q) {
      if (!q) return 0;
      const rel = this.relation(q);
      return (q.maxHp - q.hp) * 10 + (rel === 'friend' || rel === 'self' ? 8 : 0) - (rel === 'enemy' ? 30 : 0);
    }
    rankTargets(cands, valueFn) {
      const p = this.p;
      return cands.map((q) => ({ q, v: valueFn(q), d: p.seat === q.seat ? 0 : this.game.distance(p, q) }))
        .sort((a, b) => (b.v - a.v) || (a.d - b.d) || (a.q.hand.length - b.q.hand.length) || (a.q.seat - b.q.seat));
    }

    // ---------------- 选将 ----------------
    chooseGeneral(req) {
      const cands = req.candidates || [];
      let best = 0, bs = -1e9;
      for (let i = 0; i < cands.length; i++) {
        const g = cands[i];
        let s = g.hp * 3 + this.game.rng() * 3;
        const off = ['关羽', '张飞', '吕布', '马超', '黄盖', '许褚', '貂蝉', '甘宁', '张辽', '周瑜', '典韦', '庞德', '太史慈', '颜良文丑'];
        const sup = ['刘备', '郭嘉', '华佗', '孙权', '大乔', '孙尚香', '荀彧', '鲁肃', '曹丕'];
        if (this.p.role === 'rebel') s += off.includes(g.name) ? 5 : 0;
        if (this.p.role === 'lord' || this.p.role === 'loyalist') s += sup.includes(g.name) ? 5 : 0;
        if (g.skills.includes('huashen') || g.skills.includes('guhuo')) s -= 2;
        if (s > bs) { bs = s; best = i; }
      }
      return { index: best };
    }

    // ---------------- 出牌阶段 ----------------
    async choosePlay(req) {
      const actions = req.actions || [];
      const ranked = [];
      for (const a of actions) {
        if (a.kind === 'end') continue;
        let s = this.scoreAction(a);
        if (s <= 0) continue;
        if (this.level.jitter) s += (this.rnd() - 0.5) * this.level.jitter;
        if (s > this.level.threshold) ranked.push({ a, s });
      }
      ranked.sort((x, y) => y.s - x.s);
      for (const item of ranked) {
        const built = this.materialize(item.a);
        if (this.actionFeasible(item.a, built)) return built;
      }
      return { kind: 'end' };
    }

    // 动作是否真的可执行（防止引擎早退 → 空转循环）
    actionFeasible(a, m) {
      if (!m) return false;
      if (a.kind === 'card') {
        if (!m.subcards || !m.subcards.length) return false;
        for (const id of m.subcards) if (!this.game.findCard(this.p, id)) return false;
        const min = a.needsTargets ? (a.minTargets || 0) : 0;
        if ((m.targets || []).length < min) return false;
        return true;
      }
      if (a.kind === 'skill') {
        const need = a.needsCards;
        if (need) {
          const min = need.min || 0, max = need.max == null ? min : need.max;
          const cs = m.cards || [];
          if (cs.length < min || cs.length > max) return false;
          for (const id of cs) if (!byId(this.p.hand, id)) return false;
        }
        const min = a.targetCandidates && a.targetCandidates.length ? (a.minTargets || 0) : 0;
        if ((m.targets || []).length < min) return false;
        if (a.skill === 'zhijian') {
          const c = byId(this.p.hand, (m.cards || [])[0]);
          if (!c || c.type !== 'equip' || !c.subtype) return false;
        }
        if (a.skill === 'luanji') {
          const cs = (m.cards || []).map((id) => byId(this.p.hand, id)).filter(Boolean);
          if (cs.length < 2 || cs[0].suit !== cs[1].suit) return false;
        }
        if (a.skill === 'j_guose') {
          const c = byId(this.p.hand, (m.cards || [])[0]);
          if (!c || this.cardSuit(c) !== 'diamond') return false;
        }
        return true;
      }
      return false;
    }

    scoreAction(a) {
      if (a.kind === 'skill') return this.scoreSkill(a);
      const as = a.as;
      const p = this.p, g = this.game;
      const cands = (a.targetCandidates || []).map((s) => g.players[s]).filter((q) => q && q.alive);
      const card0 = byId(p.hand, (a.subcards || [])[0]) || byId(Object.values(p.equips), (a.subcards || [])[0]);
      const color = card0 ? card0.color : null;
      const nature = (CARDS[as] && CARDS[as].nature) || 'normal';

      // 无目标 / 自身为目标的基本牌与锦囊
      switch (as) {
        case 'wuzhong': return 12;
        case 'tao': return this.scoreTao();
        case 'jiu': return this.scoreJiu();
        case 'nanman': return this.scoreAoe('nanman', color);
        case 'wanjian': return this.scoreAoe('wanjian', color);
        case 'taoyuan': return this.scoreTaoyuan();
        case 'wugu': return this.scoreWugu();
        case 'tiesuo': return this.shouldChain() ? 5 : 4; // 无链时重铸摸牌
        case 'shandian': return 0;                          // 自伤风险高，普通难度不主动放
        case 'jiedao': return this.scoreJiedao(cands);
        case 'huogong': return this.scoreHuogong(cands);
        case 'lebu': case 'bingliang': case 'guohe': case 'shunshou': case 'juedou':
        case 'sha': case 'huosha': case 'leisha': {
          if (!cands.length) return 0;
          let best = 0;
          for (const q of cands) {
            const v = this.targetValue(q, as, { card: card0, color, nature, a });
            if (v > best) best = v;
          }
          return best;
        }
        default: break;
      }
      // 装备
      if (CARDS[as] && CARDS[as].type === 'equip') return this.scoreEquip(card0);
      return 0;
    }

    // 单目标价值（正数才考虑）
    targetValue(q, as, ctx = {}) {
      if (!q || !q.alive) return -100;
      const g = this.game, p = this.p;
      const rel = this.relation(q);
      const enemy = rel === 'enemy';
      const friend = rel === 'friend' || rel === 'self';
      const dist = p.seat === q.seat ? 0 : g.distance(p, q);
      const color = ctx.color || null;
      const nature = ctx.nature || 'normal';

      if (as === 'sha' || as === 'huosha' || as === 'leisha') {
        if (!enemy) return -100;
        if (q.skills.includes('kongcheng') && q.hand.length === 0) return -100;
        const armor = q.equips.armor;
        if (armor) {
          if (armor.name === 'renwang' && color === 'black') return -100;
          if (armor.name === 'tengjia' && nature === 'normal') return -100;
        }
        let v = 9 + this.threatOf(q);
        if (q.hand.length === 0) v += 6;
        else if (q.hand.length === 1) v += 1.5;
        if (q.hp <= 1) v += 9;
        v += (q.maxHp - q.hp) * 0.8;
        v += q.role === 'lord' ? 4 : 0;
        if (p.skills.includes('wushuang')) v += 3;
        if (p.drank) { v += 3; if (q.hp <= 2) v += 5; }
        if (armor && armor.name === 'bagua') v -= 2;
        if (q.skills.includes('bazhen')) v -= 2;
        if (armor && armor.name === 'tengjia' && nature === 'fire') v += 4;
        if (q.equips.weapon && q.equips.weapon.name === 'gudingdao' && p.hand.length === 0) v += 2;
        if (p.skills.includes('liegong') && q.hand.length <= g.attackRange(p)) v += 1.5;
        return v;
      }
      if (as === 'juedou') {
        if (!enemy) return -100;
        if (q.skills.includes('kongcheng') && q.hand.length === 0) return -100;
        let v = 6 + this.threatOf(q);
        if (q.hand.length === 0) v += 7;
        else if (q.hand.length === 1) v += 3;
        if (q.hp <= 1) v += 6;
        v += (q.maxHp - q.hp) * 1.2;
        if (q.skills.includes('wushuang')) v -= 4; // 对方需要两张杀
        if (!this.shaLikeCount()) v -= 5;
        return v;
      }
      if (as === 'guohe' || as === 'shunshou') {
        const gain = as === 'shunshou';
        if (enemy) {
          const hasBadJudge = q.judges.some((c) => HARM_JUDGE.includes(c.name));
          const equipVal = Object.values(q.equips).filter(Boolean).reduce((sum, c) => sum + (EQUIP_VALUE[c.name] || 4), 0);
          if (!q.hand.length && !equipVal) return -100; // 只剩其判定区的坏牌，拆了反而帮敌人
          let v = 5 + this.threatOf(q);
          if (q.equips.weapon) v += 4;
          if (q.equips.armor) v += 3;
          if (q.equips.offhorse || q.equips.defhorse) v += 1.5;
          if (q.hand.length) v += 1;
          if (gain) v += 2;
          if (hasBadJudge) v -= 3;
          return v;
        }
        if (friend && q.judges.some((c) => HARM_JUDGE.includes(c.name))) {
          let v = 7; // 帮友方拆掉乐/兵粮
          if (q.seat === this.lordSeat()) v += 3;
          return v;
        }
        return -100;
      }
      if (as === 'lebu') {
        if (!enemy) return -100;
        let v = 9 + this.threatOf(q) + (q.hand.length ? 1 : 0);
        if (q.role === 'lord') v += 4;
        if (q.hp <= 1) v -= 3; // 快死的人不用乐
        return v;
      }
      if (as === 'bingliang') {
        if (!enemy) return -100;
        return 7 + this.threatOf(q) + (q.hand.length >= 3 ? 2 : 0) + (q.role === 'lord' ? 3 : 0);
      }
      if (as === 'tiesuo') {
        if (!enemy || q.chained) return -100;
        return 5;
      }
      if (as === 'huogong') {
        if (!enemy || !q.hand.length) return -100;
        let v = 5 + (q.equips.armor && q.equips.armor.name === 'tengjia' ? 4 : 0);
        if (q.hp <= 1) v += 5;
        return v;
      }
      return 0;
    }

    scoreEquip(c) {
      if (!c || c.type !== 'equip' || !c.subtype) return 0;
      const cur = this.p.equips[c.subtype];
      let s = (EQUIP_VALUE[c.name] || 4) - (cur ? (EQUIP_VALUE[cur.name] || 4) : 0) + 3;
      if (!cur) s += 2;
      return Math.max(0, s);
    }

    scoreTao() {
      const p = this.p;
      if (p.hp >= p.maxHp) return 0;
      const taoCount = p.hand.filter((c) => c.name === 'tao').length;
      if (p.hp <= 1) return 15;
      let s = 0;
      if (p.hp <= p.maxHp - 2) s = taoCount >= 2 ? 12 : 8;
      // 手牌超过体力上限时，用桃既回血又减少弃牌
      if (p.hand.length > p.hp) s += 6;
      return s;
    }

    scoreJiu() {
      const p = this.p;
      if (p.drank) return 0;
      if (!this.alive.some((q) => q.seat !== p.seat && this.isEnemy(q))) return 0;
      if (!this.shaLikeCount()) return 0;
      if (!this.game.canUseSlash(p)) return 0;
      const lethal = this.alive.some((q) => q.seat !== p.seat && this.isEnemy(q) && q.hp <= 2 && this.game.inAttackRange(p, q));
      return lethal ? 13 : 6;
    }

    scoreAoe(asName, color) {
      const g = this.game, p = this.p;
      let s = 0, enemies = 0;
      for (const q of g.alivePlayers) {
        if (q.seat === p.seat) continue;
        if (this.aoeImmune(q, asName, color)) continue;
        const rel = this.relation(q);
        const hand = q.hand.length;
        // 手牌越多越可能打出闪/杀；八卦/八阵提高闪的成功率
        let dodge = hand === 0 ? 0 : Math.min(0.72, 0.2 * hand);
        if (asName === 'wanjian' && ((q.equips.armor && q.equips.armor.name === 'bagua') || q.skills.includes('bazhen'))) {
          dodge = Math.max(dodge, 0.5);
        }
        const hit = 1 - dodge;
        if (rel === 'enemy') { enemies++; s += (6 + (q.hp <= 1 ? 6 : 0) + (q.role === 'lord' ? 2 : 0)) * hit; }
        else if (rel === 'friend') s -= (9 + (q.hp <= 1 ? 12 : 0) + (q.seat === this.lordSeat() ? 8 : 0)) * hit;
      }
      if (!enemies) return 0;
      return s > 0 ? s : 0;
    }
    aoeImmune(q, asName, color) {
      const armor = q.equips.armor;
      if (armor && armor.name === 'tengjia') return true;
      if (q.skills.includes('weimu') && color === 'black') return true;
      if (asName === 'nanman' && (q.skills.includes('juxiang') || q.skills.includes('huoshou'))) return true;
      return false;
    }
    scoreTaoyuan() {
      const p = this.p;
      let s = -3;
      for (const q of this.alive) {
        if (q.hp >= q.maxHp) continue;
        const shed = Math.min(1, q.maxHp - q.hp);
        if (q.seat === p.seat) s += 7 * shed;
        else if (this.isFriend(q)) s += 6 * shed;
        else if (this.isEnemy(q)) s -= 7 * shed;
        else s += 1 * shed;
      }
      return s > 0 ? s : 0;
    }
    scoreWugu() {
      const p = this.p;
      const others = this.alive.filter((q) => q.seat !== p.seat);
      if (!others.length) return 0;
      if (p.hand.length > 3) return 0;
      const minOther = Math.min(...others.map((q) => q.hand.length));
      return p.hand.length <= minOther ? 3 : 0;
    }
    scoreHuogong(cands) {
      const p = this.p;
      const enemies = cands.filter((q) => this.isEnemy(q) && q.alive && q.hand.length);
      if (!enemies.length) return 0;
      const suits = new Set();
      for (const c of p.hand) if (!(c.name === 'huogong')) suits.add(c.suit);
      // 目标展示的是随机手牌，期望命中率 ≈ 已有花色数 / 4
      const hit = Math.min(1, suits.size / 4);
      if (hit < 0.5) return 0;
      let best = 0;
      for (const q of enemies) {
        let v = 4 + hit * 8 + this.threatOf(q);
        if (q.hp <= 1) v += 5;
        if (q.equips.armor && q.equips.armor.name === 'tengjia') v += 4;
        if (v > best) best = v;
      }
      return best;
    }
    scoreJiedao(cands) {
      const g = this.game, p = this.p;
      let best = 0;
      for (const killer of cands) {
        if (!killer.equips.weapon) continue;
        const kRel = this.relation(killer);
        if (kRel === 'friend') continue; // 不逼友方交武器/打人
        const seconds = g.legalSecondTargetsFor(p, 'jiedao', killer.seat).map((s) => g.players[s]).filter(Boolean);
        for (const victim of seconds) {
          const vRel = this.relation(victim);
          if (vRel === 'friend' || victim.seat === p.seat) continue;
          let v = 5;
          if (kRel === 'enemy') v += 3;
          if (vRel === 'enemy') v += 5;
          v += (EQUIP_VALUE[killer.equips.weapon.name] || 4) * 0.25;
          if (v > best) best = v;
        }
      }
      return best;
    }
    shouldChain() {
      const p = this.p;
      if (!this.alive.some((q) => q.seat !== p.seat && this.isEnemy(q) && !q.chained)) return false;
      const fire = p.hand.some((c) => ['huosha', 'leisha', 'huogong'].includes(c.name)) ||
        p.skills.includes('huoji') || p.skills.includes('huoshen');
      return !!fire;
    }

    // ---------------- 技能评分（含资源守卫） ----------------
    scoreSkill(a) {
      const g = this.game, p = this.p;
      const hand = p.hand;
      const cands = (a.targetCandidates || []).map((s) => g.players[s]).filter((q) => q && q.alive);
      const enemies = cands.filter((q) => this.isEnemy(q));
      const friends = cands.filter((q) => this.isFriend(q) && q.seat !== p.seat);
      switch (a.skill) {
        case 'rende': {
          if (hand.length < 2 || !friends.length) return 0;
          if (p.hp < p.maxHp && hand.length >= 3) return 10;
          const needy = friends.some((q) => q.hand.length === 0 || (q.seat === this.lordSeat() && q.hand.length <= 1));
          if (needy && hand.length >= 3) return 5;
          return 0;
        }
        case 'zhiheng': {
          const shan = hand.filter((c) => c.name === 'shan').length;
          let seenShan = 0;
          const bad = hand.filter((c) => {
            if (valueOf(c) <= 4) return true;
            if (c.name === 'shan' && ++seenShan > Math.max(1, shan - 1)) return true;
            return false;
          });
          return bad.length >= 2 ? 8 : 0;
        }
        case 'kurou': {
          if (p.hp <= 1) return 0;
          if (p.hp >= 3) return 7;
          return hand.length <= 2 ? 5 : 0;
        }
        case 'qingnang': {
          if (!hand.length) return 0;
          const wounded = cands.filter((q) => q.hp < q.maxHp && (q.seat === p.seat || this.isFriend(q)));
          if (!wounded.length) return 0;
          return wounded.some((q) => q.hp <= 1 || q.seat === this.lordSeat()) ? 10 : 6;
        }
        case 'fanjian': {
          if (!hand.length || !enemies.length) return 0;
          return 8;
        }
        case 'lijian': {
          if (!hand.length) return 0;
          const males = cands.filter((q) => this.isEnemy(q) && q.gender === 'male');
          return males.length >= 2 ? 11 : 0;
        }
        case 'jieyin': {
          if (hand.length < 2) return 0;
          const males = cands.filter((q) => this.isFriend(q) && q.gender === 'male' && q.hp < q.maxHp);
          if (!males.length) return 0;
          return p.hp < p.maxHp ? 9 : 6;
        }
        case 'jijiang': {
          if (this._jijiangTurn === g.turnCount) return 0; // 本回合已试过，避免无响应时重复空转
          if (p.role !== 'lord' || !g.canUseSlash(p)) return 0;
          const helpers = this.alive.filter((q) => q.seat !== p.seat && q.kingdom === '蜀' && this.isFriend(q));
          if (!helpers.length) return 0;
          return 8;
        }
        case 'qiangxi': {
          if (!enemies.length) return 0;
          const canWeapon = !!p.equips.weapon;
          if (p.hp <= 1 && !canWeapon) return 0;
          if (enemies.some((q) => q.hp <= 1)) return 10;
          return p.hp > 2 ? 7 : 4;
        }
        case 'quhu': {
          if (!hand.length || p.hp <= 1 || !enemies.length) return 0;
          return 8;
        }
        case 'tianyi': {
          if (!hand.length || !enemies.length) return 0;
          return 8;
        }
        case 'luanji': {
          const group = this.bestSuitGroup(p.hand);
          if (!group) return 0;
          const color = (group[0].suit === 'heart' || group[0].suit === 'diamond') ? 'red' : 'black';
          const s = this.scoreAoe('wanjian', color) - 1;
          return s > 1 ? s : 0;
        }
        case 'tiaoxin': {
          if (!enemies.length || p.hp <= 1) return 0;
          if (p.hp <= 2 && !this.shanCount()) return 2;
          return 6;
        }
        case 'fangquan': {
          if (!friends.length || p.hand.length > 1) return 0;
          return p.hand.length === 0 ? 8 : 7;
        }
        case 'zhijian': {
          const eq = hand.filter((c) => c.type === 'equip' && c.subtype);
          if (!eq.length || !friends.length) return 0;
          const ok = friends.some((q) => eq.some((c) => !q.equips[c.subtype]));
          return ok ? 5 : 0;
        }
        case 'luanwu': {
          const others = this.alive.filter((q) => q.seat !== p.seat);
          const en = others.filter((q) => this.isEnemy(q)).length;
          const fr = others.filter((q) => this.isFriend(q)).length;
          if (!en || en < fr) return 0;
          return 12;
        }
        case 'jixi': return 7;
        case 'shensu2': {
          if (!Object.values(p.equips).some(Boolean) || !enemies.length) return 0;
          return enemies.some((q) => q.hp <= 1) ? 9 : 0;
        }
        case 'zhiba': {
          if (!hand.length || p.kingdom !== '吴' || p.role === 'lord') return 0;
          const lord = g.lord;
          if (!lord || !lord.alive || !this.isEnemy(lord)) return 0;
          return 4;
        }
        case 'zhangba': {
          if (hand.length < 2 || !enemies.length || !g.canUseSlash(p)) return 0;
          const cs = this.selectSkillCards(a);
          if (cs.length < 2) return 0;
          const c0 = byId(hand, cs[0]);
          const hittable = enemies.some((q) => this.targetValue(q, 'sha', { color: c0 ? c0.color : null, nature: 'normal' }) > 0);
          if (!hittable) return 0;
          const hasSha = this.shaLikeCount();
          if (!hasSha) return 6;
          if (p.skills.includes('paoxiao') || (p.equips.weapon && p.equips.weapon.name === 'zhugeliannu')) return 5;
          return 0;
        }
        // ---------------- 变体主动技（extras） ----------------
        // 只有持有对应 j_* / gongxin / shizhan 的变体武将才会进入这些 case，基础将无这些 id。
        case 'j_rende': {
          if (!hand.length) return 0;
          const given = (p.flags && p.flags.rendeGiven) || {};
          const giveTargets = cands.filter((q) => this.isFriend(q) && !given[q.seat]);
          if (!giveTargets.length) return 0;
          const canSha = g.canUseSlash(p) && g.legalTargetsFor(p, 'sha', null).some((s2) => this.isEnemy(g.players[s2]));
          if (hand.length >= 3 && (p.hp < p.maxHp || canSha)) return 8;
          if (giveTargets.some((q) => q.hand.length === 0) && hand.length >= 2) return 5;
          if (giveTargets.some((q) => q.seat === this.lordSeat()) && hand.length >= 2) return 4;
          return 0;
        }
        case 'j_zhiheng': {
          const bad = this.zhihengBadCards();
          if (hand.length <= 1) return 8;      // 弃光手牌额外摸 1，1 张换 2 张
          if (bad.length >= 2) return 7;
          if (hand.length <= 2 && bad.length >= 1) return 5;
          return 0;
        }
        case 'j_kurou': {
          // 界苦肉本身是纯亏；只有配合锁定技【诈降】才有收益
          if (!p.skills.includes('j_zhaxiang') || p.hp <= 1 || !hand.length) return 0;
          if (p.hp >= 3) return 9;
          return this.shanCount() ? 5 : 0;
        }
        case 'gongxin': {
          if (!enemies.length) return 0;
          const withHand = enemies.filter((q) => q.hand.length);
          if (!withHand.length) return 0;
          const maxHand = Math.max(...withHand.map((q) => q.hand.length));
          return 4 + Math.min(4, maxHand);
        }
        case 'shizhan': {
          if (!enemies.length) return 0;
          const mySha = this.shaLikeCount();
          if (!mySha) return 0;
          const t = enemies.slice().sort((x, y) => (x.hand.length - y.hand.length) || (x.hp - y.hp))[0];
          if (!t) return 0;
          if (t.skills.includes('wushuang') && mySha < 2) return 0; // 无双：己方需两张杀
          if (t.hand.length === 0) return 8;  // 对方无杀，决斗必吃伤害
          if (mySha >= 2) return 6;
          if (t.hp <= 1) return 5;
          return 0;
        }
        case 'jianyan': {
          if (!this.jianyanRecipient()) return 0;
          return 6; // 声明基本牌，从牌堆找一张交给男性（自己或友方）
        }
        case 'j_fanjian': {
          if (!hand.length || !enemies.length) return 0;
          return 7 + (enemies.some((q) => q.hand.length >= 3) ? 1 : 0);
        }
        case 'j_yijue': {
          const hasEquip = Object.values(p.equips).some(Boolean);
          if (!hand.length && !hasEquip) return 0;
          if (hand.length === 1) return 0;    // 需要手牌时不能改用装备，最后一张不赌
          if (!hand.length) {
            const eqVals = Object.values(p.equips).filter(Boolean).map((c) => EQUIP_VALUE[c.name] || 4);
            if (!eqVals.length || Math.min(...eqVals) > 6) return 0;
          }
          if (!enemies.some((q) => q.hand.length)) return 0;
          return 7 + (enemies.some((q) => q.hp <= 1 || q.role === 'lord') ? 1 : 0);
        }
        case 'j_guose': {
          const diamonds = hand.filter((c) => this.cardSuit(c) === 'diamond');
          if (!diamonds.length) return 0;
          const friendlyLebu = this.alive.some((q) => (q.seat === p.seat || this.isFriend(q)) && q.judges.some((c) => c.name === 'lebu'));
          if (friendlyLebu) return 8; // 弃方块+乐，摸一张，净赚
          const legal = g.legalTargetsFor(p, 'lebu', null).map((s2) => g.players[s2]).filter(Boolean);
          if (!legal.length) return 0;
          let best = 0;
          for (const q of legal) best = Math.max(best, this.targetValue(q, 'lebu', {}));
          return best > 0 ? Math.min(9, best + 1) : 0;
        }
        case 'j_jieyin': {
          if (!cands.some((q) => this.jieyinViable(q))) return 0;
          const males = cands.filter((q) => this.jieyinViable(q));
          return 6 + (p.hp < p.maxHp && males.some((q) => q.hp > p.hp) ? 2 : 0);
        }
        case 'j_chuli': {
          if (hand.length < 2) return 0;
          const kingdoms = new Set();
          for (const q of enemies) if (q.alive && (q.hand.length || Object.values(q.equips).some(Boolean))) kingdoms.add(q.kingdom);
          if (!kingdoms.size) return 0;
          const n = Math.min(3, kingdoms.size, Math.max(1, hand.length - 1));
          const spades = hand.filter((c) => this.cardSuit(c) === 'spade').length;
          return 4 + n * 1.5 + Math.min(spades, n) * 1.5; // 黑桃弃牌可摸回，近似免费
        }
        case 'guhuo': return 0; // 普通难度不赌蛊惑
        default: return 0;
      }
    }

    // ---------------- 补全动作 ----------------
    materialize(a) {
      const p = this.p;
      const out = { kind: a.kind, skill: a.skill || null, as: a.as || null, cards: [], targets: [] };
      if (a.kind === 'card') {
        out.subcards = (a.subcards || []).slice();
        out.cards = out.subcards.slice();
        out.targets = this.selectCardTargets(a);
        return out;
      }
      out.cards = this.selectSkillCards(a);
      out.targets = this.selectSkillTargets(a, out.cards);
      if (a.skill === 'jijiang') this._jijiangTurn = this.game.turnCount;
      if (a.skill === 'j_jieyin') this._jieyinTargetSeat = out.targets.length ? out.targets[0] : null;
      return out;
    }

    selectCardTargets(a) {
      const g = this.game, p = this.p;
      const as = a.as;
      const cands = (a.targetCandidates || []).map((s) => g.players[s]).filter((q) => q && q.alive);
      if (!cands.length) return [];
      if (as === 'tiesuo') {
        if (!this.shouldChain()) return []; // 重铸
        const ranked = this.rankTargets(cands.filter((q) => this.isEnemy(q) && !q.chained), (q) => this.targetValue(q, 'tiesuo'));
        const max = Math.min(a.maxTargets || 2, 2);
        return ranked.slice(0, max).map((x) => x.q.seat);
      }
      if (as === 'jiedao') {
        const pair = this.pickJiedaoPair(cands);
        return pair || [];
      }
      if (!a.needsTargets) return [];
      const min = a.minTargets || 0, max = a.maxTargets == null ? min : a.maxTargets;
      const card0 = byId(p.hand, (a.subcards || [])[0]) || byId(Object.values(p.equips), (a.subcards || [])[0]);
      const ctx = { card: card0, color: card0 ? card0.color : null, nature: (CARDS[as] && CARDS[as].nature) || 'normal', a };
      const ranked = this.rankTargets(cands, (q) => this.targetValue(q, as, ctx));
      const picked = ranked.filter((x) => x.v > 0).slice(0, Math.max(1, max));
      if (picked.length < Math.max(1, min)) return [];
      return picked.map((x) => x.q.seat);
    }

    pickJiedaoPair(cands) {
      const g = this.game, p = this.p;
      let best = null, bs = -1;
      for (const killer of cands) {
        if (!killer.equips.weapon || this.isFriend(killer)) continue;
        const seconds = g.legalSecondTargetsFor(p, 'jiedao', killer.seat).map((s) => g.players[s]).filter(Boolean);
        for (const victim of seconds) {
          if (this.isFriend(victim) || victim.seat === p.seat) continue;
          let v = 5;
          if (this.isEnemy(killer)) v += 3;
          if (this.isEnemy(victim)) v += 5;
          v += (EQUIP_VALUE[killer.equips.weapon.name] || 4) * 0.25;
          if (v > bs) { bs = v; best = [killer.seat, victim.seat]; }
        }
      }
      return best;
    }

    bestSuitGroup(hand) {
      const by = {};
      for (const c of hand) (by[c.suit] = by[c.suit] || []).push(c);
      let best = null, bv = 1e9;
      for (const suit of Object.keys(by)) {
        const arr = by[suit];
        if (arr.length < 2) continue;
        const sum = arr.slice().sort((x, y) => valueOf(x) - valueOf(y)).slice(0, 2).reduce((s, c) => s + valueOf(c), 0);
        if (sum < bv) { bv = sum; best = arr; }
      }
      if (!best) return null;
      return best.slice().sort((x, y) => valueOf(x) - valueOf(y)).slice(0, 2);
    }

    selectSkillCards(a) {
      const p = this.p;
      const hand = p.hand.slice();
      const low = () => hand.slice().sort((x, y) => valueOf(x) - valueOf(y));
      const min = a.needsCards ? a.needsCards.min || 0 : 0;
      const out = (arr) => arr.slice(0, Math.max(min, Math.min(a.needsCards ? (a.needsCards.max == null ? min : a.needsCards.max) : 0, arr.length))).map((c) => c.id);
      switch (a.skill) {
        case 'rende': {
          const desired = p.hp < p.maxHp ? 2 : 1;
          const n = Math.max(1, Math.min(desired, hand.length - 1));
          return low().slice(0, n).map((c) => c.id);
        }
        case 'zhiheng': {
          const shan = hand.filter((c) => c.name === 'shan').length;
          let seen = 0;
          const bad = hand.filter((c) => {
            if (valueOf(c) <= 4) return true;
            if (c.name === 'shan' && ++seen > Math.max(1, shan - 1)) return true;
            return false;
          });
          return (bad.length ? bad : low().slice(0, 1)).map((c) => c.id);
        }
        case 'qingnang': case 'fanjian': case 'lijian':
          return low().slice(0, 1).map((c) => c.id);
        case 'jieyin':
          return low().slice(0, 2).map((c) => c.id);
        case 'j_rende': {
          const canSha = this.game.canUseSlash(p) && this.game.legalTargetsFor(p, 'sha', null).some((s2) => this.isEnemy(this.game.players[s2]));
          const want = (p.hp < p.maxHp || canSha || hand.length >= 4) ? 2 : 1;
          const n = Math.max(1, Math.min(want, Math.max(1, hand.length - 1)));
          return low().slice(0, n).map((c) => c.id);
        }
        case 'j_zhiheng': {
          if (hand.length <= 2) return hand.map((c) => c.id);
          const bad = this.zhihengBadCards();
          return (bad.length ? bad : low().slice(0, 1)).map((c) => c.id);
        }
        case 'j_kurou':
          return low().slice(0, 1).map((c) => c.id);
        case 'j_fanjian':
          return low().slice(0, 1).map((c) => c.id);
        case 'j_yijue':
          return hand.length ? low().slice(0, 1).map((c) => c.id) : [];
        case 'j_guose': {
          const diamonds = hand.filter((c) => this.cardSuit(c) === 'diamond').sort((a, b) => valueOf(a) - valueOf(b));
          return diamonds.length ? [diamonds[0].id] : [];
        }
        case 'luanji': {
          const group = this.bestSuitGroup(hand);
          return group ? group.map((c) => c.id) : [];
        }
        case 'zhangba':
          return low().slice(0, 2).map((c) => c.id);
        case 'zhijian': {
          const eq = low().filter((c) => c.type === 'equip' && c.subtype);
          return eq.length ? [eq[0].id] : [];
        }
        default:
          if (a.needsCards) return out(low());
          return [];
      }
    }

    selectSkillTargets(a, cards) {
      const g = this.game, p = this.p;
      const cands = (a.targetCandidates || []).map((s) => g.players[s]).filter((q) => q && q.alive);
      if (!cands.length) return [];
      switch (a.skill) {
        case 'rende': {
          const f = cands.filter((q) => this.isFriend(q) && q.seat !== p.seat)
            .sort((x, y) => (this.healNeed(y) - this.healNeed(x)) || (x.hand.length - y.hand.length));
          return f.length ? [f[0].seat] : [];
        }
        case 'qingnang': {
          const f = cands.filter((q) => (q.seat === p.seat || this.isFriend(q)) && q.hp < q.maxHp)
            .sort((x, y) => this.healNeed(y) - this.healNeed(x));
          return f.length ? [f[0].seat] : [];
        }
        case 'jieyin': {
          const f = cands.filter((q) => this.isFriend(q) && q.gender === 'male' && q.hp < q.maxHp)
            .sort((x, y) => this.healNeed(y) - this.healNeed(x));
          return f.length ? [f[0].seat] : [];
        }
        case 'fanjian': {
          const e = this.rankTargets(cands.filter((q) => this.isEnemy(q)), (q) => this.scoreTarget(q));
          return e.length ? [e[0].q.seat] : [];
        }
        case 'lijian': {
          const males = cands.filter((q) => this.isEnemy(q) && q.gender === 'male')
            .sort((x, y) => y.hand.length - x.hand.length);
          if (males.length < 2) return [];
          // 第二个目标先响应【杀】：把手牌少的放第二，更可能打不出杀
          return [males[0].seat, males[males.length - 1].seat];
        }
        case 'j_rende': {
          const given = (p.flags && p.flags.rendeGiven) || {};
          const f = cands.filter((q) => this.isFriend(q) && q.seat !== p.seat && !given[q.seat]);
          if (!f.length) return [];
          f.sort((x, y) => ((y.hand.length === 0 ? 1 : 0) - (x.hand.length === 0 ? 1 : 0)) || (this.healNeed(y) - this.healNeed(x)) || (x.hand.length - y.hand.length));
          return [f[0].seat];
        }
        case 'gongxin': {
          const e = this.rankTargets(cands.filter((q) => this.isEnemy(q) && q.hand.length), (q) => q.hand.length * 2 + this.threatOf(q));
          return e.length ? [e[0].q.seat] : [];
        }
        case 'shizhan': {
          const e = this.rankTargets(cands.filter((q) => this.isEnemy(q)), (q) => (q.hand.length === 0 ? 8 : 0) + (q.hp <= 1 ? 6 : 0) - q.hand.length * 1.2 + this.threatOf(q));
          return e.length ? [e[0].q.seat] : [];
        }
        case 'j_fanjian': {
          const e = this.rankTargets(cands.filter((q) => this.isEnemy(q)), (q) => q.hand.length * 2 + (q.hp <= 1 ? 5 : 0) + this.threatOf(q));
          return e.length ? [e[0].q.seat] : [];
        }
        case 'j_yijue': {
          const e = this.rankTargets(cands.filter((q) => this.isEnemy(q) && q.hand.length), (q) => this.threatOf(q) + (q.hp <= 1 ? 3 : 0) - q.hand.length * 0.2);
          return e.length ? [e[0].q.seat] : [];
        }
        case 'j_jieyin': {
          const f = cands.filter((q) => this.jieyinViable(q));
          if (!f.length) return [];
          const w = (q) => (p.hp < p.maxHp ? (q.hp > p.hp ? 2 : (q.hp < p.hp ? 1 : 0)) : (q.hp < p.hp ? 2 : (q.hp > p.hp ? 1 : 0)));
          f.sort((x, y) => (w(y) - w(x)) || (this.healNeed(y) - this.healNeed(x)) || (x.hand.length - y.hand.length));
          return [f[0].seat];
        }
        case 'j_chuli': {
          const e = cands.filter((q) => this.isEnemy(q) && (q.hand.length || Object.values(q.equips).some(Boolean)));
          const seen = new Set();
          const out = [];
          e.sort((x, y) => ((y.equips.weapon ? 1 : 0) - (x.equips.weapon ? 1 : 0)) || (y.hand.length - x.hand.length));
          const cap = Math.min(3, a.maxTargets || 3, Math.max(1, p.hand.length - 1));
          for (const q of e) {
            if (seen.has(q.kingdom)) continue;
            seen.add(q.kingdom);
            out.push(q);
            if (out.length >= cap) break;
          }
          return out.map((q) => q.seat);
        }
        case 'jijiang': {
          const t = this.rankTargets(cands.filter((q) => this.isEnemy(q)), (q) => this.targetValue(q, 'sha', {}));
          return t.length ? [t[0].q.seat] : [];
        }
        case 'qiangxi': case 'shensu2': {
          const t = this.rankTargets(cands.filter((q) => this.isEnemy(q)), (q) => this.scoreTarget(q) + (q.hp <= 1 ? 20 : 0));
          return t.length ? [t[0].q.seat] : [];
        }
        case 'quhu': case 'tianyi': {
          const e = cands.filter((q) => this.isEnemy(q))
            .sort((x, y) => (x.hand.length - y.hand.length) || (this.scoreTarget(y) - this.scoreTarget(x)));
          return e.length ? [e[0].seat] : [];
        }
        case 'tiaoxin': {
          const e = this.rankTargets(cands.filter((q) => this.isEnemy(q)), (q) => this.scoreTarget(q) + (q.hand.length === 0 ? 5 : 0));
          return e.length ? [e[0].q.seat] : [];
        }
        case 'fangquan': {
          const f = cands.filter((q) => this.isFriend(q) && q.seat !== p.seat)
            .sort((x, y) => (y.hand.length - x.hand.length) || (this.scoreTarget(y) - this.scoreTarget(x)));
          return f.length ? [f[0].seat] : [];
        }
        case 'zhijian': {
          const card = byId(p.hand, (cards || [])[0]);
          if (!card || !card.subtype) return [];
          const f = cands.filter((q) => this.isFriend(q) && !q.equips[card.subtype])
            .sort((x, y) => this.healNeed(y) - this.healNeed(x));
          return f.length ? [f[0].seat] : [];
        }
        case 'jixi': {
          const e = this.rankTargets(cands.filter((q) => this.isEnemy(q) && this.game.allCardsOf(q).length), (q) => this.scoreTarget(q));
          return e.length ? [e[0].q.seat] : [];
        }
        case 'zhiba': {
          const lord = this.game.lord;
          return lord && lord.alive ? [lord.seat] : [];
        }
        case 'zhangba': {
          const c0 = byId(p.hand, (cards || [])[0]);
          const ctx = { color: c0 ? c0.color : null, nature: 'normal' };
          const t = this.rankTargets(cands.filter((q) => this.isEnemy(q)), (q) => this.targetValue(q, 'sha', ctx));
          return t.length && t[0].v > 0 ? [t[0].q.seat] : [];
        }
        default: {
          if (!a.targetCandidates) return [];
          const min = a.minTargets || 1, max = a.maxTargets == null ? min : a.maxTargets;
          const ranked = this.rankTargets(cands, (q) => this.scoreTarget(q));
          return ranked.slice(0, Math.max(min, Math.min(max, ranked.length))).map((x) => x.q.seat);
        }
      }
    }

    // ---------------- 响应 ----------------
    chooseResponse(req) {
      const p = this.p;
      const opts = req.options || [];
      if (!opts.length) return null;
      const need = req.need;
      if (need === 'wuxie') return this.chooseWuxie(req);
      if (need === 'guicai' || need === 'guidao') return this.chooseJudgeCard(req);
      if (need === 'discardEquip') return this.chooseDiscardEquip(opts);
      if (need === 'shan') {
        if (this.level.shanRespond < 1 && !this.chance(this.level.shanRespond)) return null;
        return this.pickResponseCard(opts);
      }
      if (need === 'sha') return this.chooseShaResponse(req);
      if (need === 'tao') return this.choosePeachResponse(req);
      return this.pickResponseCard(opts);
    }

    chooseShaResponse(req) {
      const p = this.p;
      const opts = req.options || [];
      if (!opts.length) return null;
      if (!req.mustUse && this.level.shaRespond < 1 && p.hp > 1 && !this.chance(this.level.shaRespond)) return null;
      return this.pickResponseCard(opts);
    }

    choosePeachResponse(req) {
      const g = this.game, p = this.p;
      const opts = req.options || [];
      const dying = g.players[req.dyingSeat];
      if (!dying) return null;
      if (dying.seat === p.seat) return this.pickResponseCard(opts);
      const rel = this.relation(dying);
      const taoCount = opts.filter((o) => {
        const c = g.findCard(p, o.cardId);
        return c && (c.name === 'tao' || o.as === 'tao');
      }).length;
      // 内奸：反贼还在时保主公
      if (p.role === 'renegade') {
        const rebels = g.alivePlayers.filter((q) => q.role === 'rebel' && q.revealed).length;
        if (dying.role === 'lord' && rebels > 0) return this.pickResponseCard(opts);
        return null;
      }
      if (rel === 'enemy') return null;
      if (dying.seat === this.lordSeat()) return this.pickResponseCard(opts);
      if (rel === 'friend') {
        if (p.hp <= 1 && taoCount <= 1) return null;
        if (this.level.peachFriend < 1 && !this.chance(this.level.peachFriend)) return null;
        return this.pickResponseCard(opts);
      }
      return null;
    }

    chooseWuxie(req) {
      const g = this.game, p = this.p;
      const card = req.card;
      if (!card) return null;
      const target = g.players[req.targetSeat];
      if (!target) return null;
      const harmful = ['juedou', 'guohe', 'shunshou', 'lebu', 'bingliang', 'nanman', 'wanjian', 'huogong', 'jiedao', 'shandian'];
      const beneficial = ['wuzhong', 'taoyuan', 'wugu'];
      const friend = target.seat === p.seat || this.isFriend(target);
      const enemy = this.isEnemy(target);
      let want = false;
      if (harmful.includes(card.name)) {
        // 已生效 → 友方要抵消；已被抵消 → 敌方要反抵消
        want = friend ? !req.negated : (enemy ? !!req.negated : false);
      } else if (beneficial.includes(card.name)) {
        want = friend ? !!req.negated : (enemy ? !req.negated : false);
      } else {
        return null;
      }
      if (!want) return null;
      if (this.level.wuxie < 1 && !this.chance(this.level.wuxie)) return null;
      // 【过河拆桥】对空手无装备的敌人收益低，不浪费无懈
      if (card.name === 'guohe' && target.hand.length <= 1 && !Object.values(target.equips).some(Boolean) && !target.judges.length) return null;
      return this.pickResponseCard(req.options || []);
    }

    chooseDiscardEquip(opts) {
      const p = this.p;
      const scored = opts.map((o) => ({ o, v: valueOf(this.game.findCard(p, o.cardId)) }))
        .sort((a, b) => a.v - b.v || a.o.cardId - b.o.cardId);
      return scored[0] ? { cardId: scored[0].o.cardId } : null;
    }

    pickResponseCard(opts) {
      const p = this.p, g = this.game;
      const scored = opts.map((o) => {
        const c = g.findCard(p, o.cardId);
        return { o, v: valueOf(c) - (o.skill ? 1.5 : 0) };
      }).sort((a, b) => a.v - b.v);
      return scored[0] ? { cardId: scored[0].o.cardId, as: scored[0].o.as, skill: scored[0].o.skill } : null;
    }

    // 鬼才/鬼道：从战报里解析本次判定「谁判定 / 判定原因 / 判定牌」
    judgeContext() {
      const logs = this.game.logs || [];
      for (let i = logs.length - 1; i >= 0; i--) {
        const m = /^(.*?) 判定（(.*?)）：(.*)$/.exec(logs[i].text || '');
        if (!m) continue;
        const name = m[1], reason = m[2], cardText = m[3];
        const cm = /【([^】]+)】([♠♥♣♦])(A|J|Q|K|\d+)/.exec(cardText);
        if (!cm) return null;
        const suit = Object.keys(SUITS).find((s) => SUITS[s].cn === cm[2]);
        const rank = cm[3] === 'A' ? 1 : cm[3] === 'J' ? 11 : cm[3] === 'Q' ? 12 : cm[3] === 'K' ? 13 : Number(cm[3]);
        let owner = null;
        for (const q of this.alive) if (this.game.nameOf(q) === name) { owner = q; break; }
        return { name, reason, cardName: cm[1], suit, rank, owner };
      }
      return null;
    }

    // 判定“对判定者有利”的结果
    judgeGoodResult(reason, suit, rank) {
      if (/乐不思蜀/.test(reason)) return suit === 'heart';
      if (/兵粮寸断/.test(reason)) return suit === 'club';
      if (/闪电/.test(reason)) return !(suit === 'spade' && rank >= 2 && rank <= 9);
      if (/铁骑/.test(reason)) return suit === 'heart' || suit === 'diamond';
      if (/八卦阵|八阵/.test(reason)) return suit === 'heart' || suit === 'diamond';
      if (/雷击/.test(reason)) return suit === 'spade';
      if (/刚烈/.test(reason)) return suit !== 'heart';
      if (/暴虐/.test(reason)) return suit === 'spade';
      if (/屯田/.test(reason)) return suit !== 'heart';
      if (/悲歌/.test(reason)) return suit === 'heart' || suit === 'diamond';
      return null;
    }

    chooseJudgeCard(req) {
      const g = this.game, p = this.p, opts = req.options || [];
      if (!opts.length) return null;
      const ctx = this.judgeContext();
      if (!ctx || !ctx.owner) return null;
      const curGood = this.judgeGoodResult(ctx.reason, ctx.suit, ctx.rank);
      if (curGood == null) return null;
      const rel = this.relation(ctx.owner);
      if (rel === 'neutral') return null;
      const wantGood = rel === 'friend' || rel === 'self';
      if (curGood === wantGood) return null; // 当前结果已经有利，不浪费手牌
      const scored = [];
      for (const o of opts) {
        const c = g.findCard(p, o.cardId);
        if (!c) continue;
        const good = this.judgeGoodResult(ctx.reason, c.suit, c.rank);
        if (good === wantGood) scored.push({ o, v: valueOf(c) });
      }
      if (!scored.length) return null;
      scored.sort((a, b) => a.v - b.v || a.o.cardId - b.o.cardId);
      const pick = scored[0];
      // 花费太大就不改（自己判定除外）
      if (pick.v >= 8 && rel !== 'self') return null;
      return { cardId: pick.o.cardId };
    }

    // ---------------- 选择牌 ----------------
    // 实际花色（红颜等改花色技能按 effective suit 计）
    cardSuit(c) {
      if (!c) return null;
      return this.game.suitOf ? this.game.suitOf(this.p, c) : c.suit;
    }

    // 制衡（界）可弃的“坏牌”：低价值 + 多余闪
    zhihengBadCards() {
      const hand = this.p.hand;
      const shan = hand.filter((c) => c.name === 'shan').length;
      let seen = 0;
      return hand.filter((c) => {
        if (valueOf(c) <= 4) return true;
        if (c.name === 'shan' && ++seen > Math.max(1, shan - 1)) return true;
        return false;
      });
    }

    // 荐言受益人：自己（男性）优先，否则友方男性
    jianyanRecipient() {
      const p = this.p;
      if (p.gender === 'male' && p.alive) return p;
      return this.alive.find((q) => q.seat !== p.seat && q.gender === 'male' && this.isFriend(q)) || null;
    }

    // 结姻（界）是否可行：目标为友方男性且体力不同；无手牌时需有可给的装备
    jieyinViable(q) {
      const p = this.p;
      if (!q || q.seat === p.seat || q.gender !== 'male' || q.hp === p.hp) return false;
      if (p.hand.length) return true;
      for (const k of Object.keys(p.equips)) {
        const c = p.equips[k];
        if (!c) continue;
        const cur = q.equips[k];
        if (!cur || (EQUIP_VALUE[cur.name] || 4) <= (EQUIP_VALUE[c.name] || 4) + 1) return true;
      }
      return false;
    }

    // 弃牌时“保留价值”：优先弃多余闪/桃、重复装备，尽量保住进攻牌
    discardKeepValue(c) {
      const p = this.p;
      const hand = p.hand;
      let v = valueOf(c);
      if (c.name === 'shan') {
        const n = hand.filter((x) => x.name === 'shan').length;
        if (n <= 2) v += 3;
        else if (n === 3) v -= 2;
        else v -= 4;
      } else if (['sha', 'huosha', 'leisha'].includes(c.name)) {
        const n = hand.filter((x) => ['sha', 'huosha', 'leisha'].includes(x.name)).length;
        if (n <= 1) v += 4;
        else if (n === 2) v += 1;
        else v -= 2;
        if (!this.game.legalTargetsFor(p, 'sha', null).length) v -= 2;
      } else if (c.name === 'tao') {
        const n = hand.filter((x) => x.name === 'tao').length;
        if (n <= 2) v += 4;
        else v -= 4;
      } else if (c.type === 'equip') {
        const cur = p.equips[c.subtype];
        if (cur) v -= (EQUIP_VALUE[cur.name] || 4) >= (EQUIP_VALUE[c.name] || 4) ? 5 : 2;
      } else if (c.name === 'wuxie') {
        v += 1;
      } else if (c.name === 'wugu' || c.name === 'taoyuan') {
        if (this.alive.length <= 3) v -= 3; // 残局群体锦囊收益低
      }
      return v;
    }

    chooseCards(req) {
      const p = this.p;
      const cards = (req.cards || []).map((c) => (c && typeof c === 'object' ? c : this.game.findCard(p, c))).filter(Boolean);
      const min = req.min || 0, max = req.max == null ? min : req.max;
      if (!cards.length) return [];
      const reason = req.reason || '';

      // 拼点：必须出大点，平局算输
      if (/拼点/.test(reason)) {
        const best = cards.slice().sort((a, b) => (b.rank - a.rank) || (valueOf(a) - valueOf(b)))[0];
        return [best.id];
      }
      // 火攻：弃同花色牌造成伤害；只在极度危险且要弃桃时放弃
      if (/火攻/.test(reason)) {
        const low = cards.slice().sort((a, b) => valueOf(a) - valueOf(b))[0];
        if (!low) return [];
        if (p.hp <= 1 && valueOf(low) >= 9) return [];
        return [low.id];
      }

      // 攻心：选择价值最高的红桃牌弃置（牌池已是目标手牌中的红桃）
      if (/攻心/.test(reason)) {
        const best = cards.slice().sort((a, b) => valueOf(b) - valueOf(a) || a.id - b.id)[0];
        return best ? [best.id] : [];
      }
      // 除疠：优先弃黑桃（被弃者/自己摸一张，近似免费）；否则弃最低价值
      if (/除疠/.test(reason)) {
        const spades = cards.filter((c) => this.cardSuit(c) === 'spade').sort((a, b) => valueOf(a) - valueOf(b));
        if (spades.length) return [spades[0].id];
        const low = cards.slice().sort((a, b) => valueOf(a) - valueOf(b) || a.id - b.id)[0];
        return low ? [low.id] : [];
      }

      let n = Math.max(min, Math.min(max, cards.length));
      if (min === 0) n = 0;
      if (/弃置|弃牌|交给|好施|缔盟|悲歌|天香|放权|刚烈|贯石斧|享乐|流离/.test(reason) && req.min > 0) n = min;
      const isDiscardPhase = /^弃牌阶段/.test(reason);
      const sorted = cards.slice().sort((a, b) => {
        const va = isDiscardPhase ? this.discardKeepValue(a) : valueOf(a);
        const vb = isDiscardPhase ? this.discardKeepValue(b) : valueOf(b);
        return va - vb || a.id - b.id;
      });
      return sorted.slice(0, n).map((c) => c.id);
    }

    chooseTargets(req) {
      const g = this.game, p = this.p;
      const reason = req.reason || '';
      const raw = req.candidates || [];
      // 化身候选是下标，不是座位
      if (/化身/.test(reason)) return raw.length ? [raw[0]] : [];
      const cands = raw.map((s) => g.players[s]).filter((q) => q && q.alive);
      if (!cands.length) return [];
      const min = req.min || 1, max = req.max == null ? min : req.max;
      const n = Math.max(min, Math.min(max, cands.length));

      // 荐言：自己（男性）优先，其次友方男性
      if (/荐言/.test(reason)) {
        if (p.gender === 'male' && raw.includes(p.seat)) return [p.seat];
        const f = this.rankTargets(cands.filter((q) => q.gender === 'male' && this.isFriend(q)), (q) => this.healNeed(q) - q.hand.length);
        return f.length ? [f[0].q.seat] : raw.slice(0, 1);
      }
      // 国色弃乐：只弃友方/自己判定区的乐
      if (/国色：选择场上一张/.test(reason)) {
        const f = cands.filter((q) => q.seat === p.seat || this.isFriend(q));
        const pick = (f.length ? f : cands)[0];
        return pick ? [pick.seat] : [];
      }
      // 连营：给自己/友方摸牌
      if (/连营/.test(reason)) {
        const f = this.rankTargets(cands.filter((q) => q.seat === p.seat || this.isFriend(q)), (q) => this.healNeed(q) - q.hand.length);
        const n = Math.max(min, Math.min(max, f.length));
        return f.slice(0, n).map((x) => x.q.seat);
      }

      const wantEnemy = /驱虎|雷击|伤害|转移|流离|天香|杀的目标|挑衅|决斗|乱武|蛊惑|放逐|巧变/.test(reason);
      const wantFriend = !wantEnemy && /回复|交给|仁德|青囊|结姻|放权|直谏|节命|英魂|好施|遗计|补至|回血/.test(reason);

      let ranked;
      if (wantEnemy) {
        ranked = this.rankTargets(cands, (q) => this.scoreTarget(q));
      } else if (wantFriend) {
        ranked = this.rankTargets(cands, (q) => this.healNeed(q) - q.hand.length * 0.5);
      } else {
        ranked = this.rankTargets(cands, (q) => this.scoreTarget(q));
      }
      return ranked.slice(0, n).map((x) => x.q.seat);
    }

    chooseOption(req) {
      const p = this.p;
      const opts = req.options || [];
      const ids = opts.map((o) => o.id);
      const has = (id) => ids.includes(id);
      const reason = req.reason || '';

      // 斗地主叫/抢地主：按手牌强度决定
      if (this.game.ddzMode && /叫地主|抢地主/.test(reason)) {
        let score = 0;
        const val = { sha: 3, huosha: 4, leisha: 4, tao: 3, wuzhong: 4, juedou: 3, shunshou: 3, guohe: 2, wuxie: 2, jiu: 2 };
        (p.hand || []).forEach((c) => { score += val[c.name] || 1; });
        const rob = /抢地主/.test(reason);
        return score >= (rob ? 8 : 6) ? ids[0] : ids[1];
      }
      // 蛊惑质疑：默认相信友方、怀疑敌方
      if (/质疑/.test(reason)) return this.shouldDoubt(reason) ? 'yes' : 'no';

      // ---------------- 变体主动技的选项 ----------------
      // 国色（界）：优先弃方块+友方/自己的【乐不思蜀】；否则当【乐不思蜀】用
      if (/【国色】/.test(reason)) {
        const friendlyLebu = this.alive.some((q) => (q.seat === p.seat || this.isFriend(q)) && q.judges.some((c) => c.name === 'lebu'));
        if (friendlyLebu && has('remove')) return 'remove';
        return has('lebu') ? 'lebu' : ids[0];
      }
      // 结姻（界）：有可给的装备就置入装备（友方白得一张装备），否则弃手牌
      if (/【结姻】：弃置一张手牌/.test(reason) && has('hand') && has('equip')) {
        const target = this.game.players[this._jieyinTargetSeat];
        const eqKeys = Object.keys(p.equips).filter((k) => p.equips[k]);
        if (!p.hand.length && eqKeys.length) return 'equip';
        if (!eqKeys.length) return 'hand';
        const spare = eqKeys.filter((k) => {
          const cur = target ? target.equips[k] : null;
          return !cur || (EQUIP_VALUE[cur.name] || 4) <= (EQUIP_VALUE[p.equips[k].name] || 4) + 1;
        });
        if (spare.length) return 'equip';
        return 'hand';
      }
      // 结姻（界）：选择置入哪件装备：优先目标空栏位、其次价值最低
      if (/【结姻】：选择要置入其装备区的装备/.test(reason)) {
        const target = this.game.players[this._jieyinTargetSeat];
        const eqKeys = ids.filter((k) => p.equips[k]).sort((k1, k2) => {
          const e1 = target && !target.equips[k1] ? 0 : 1;
          const e2 = target && !target.equips[k2] ? 0 : 1;
          return (e1 - e2) || ((EQUIP_VALUE[p.equips[k1].name] || 4) - (EQUIP_VALUE[p.equips[k2].name] || 4));
        });
        return eqKeys.length ? eqKeys[0] : ids[0];
      }
      // 仁德（界）第二张后：优先保命桃，其次杀，最后酒
      if (/【仁德】：本阶段已给出第二张牌/.test(reason)) {
        if (has('tao') && p.hp <= 2) return 'tao';
        if (has('sha')) return 'sha';
        if (has('tao')) return 'tao';
        if (has('jiu') && this.shaLikeCount() > 0) return 'jiu';
        return 'no';
      }
      // 反间（界）目标：同花色多且血量健康时宁可掉 1 血
      if (/【反间】：展示所有手牌/.test(reason) && has('discard') && has('losehp')) {
        if (p.hp <= 1) return 'discard';
        const counts = {};
        for (const c of p.hand) {
          const su = this.cardSuit(c);
          counts[su] = (counts[su] || 0) + 1;
        }
        const maxSuit = Math.max(0, ...Object.values(counts));
        return (p.hp >= 3 && maxSuit >= 3) ? 'losehp' : 'discard';
      }
      // 义绝：友方才令其回血，敌人不回
      if (/【义绝】：是否令/.test(reason) && has('yes') && has('no')) {
        const m = /令 (.+?) 回复/.exec(reason);
        if (m) {
          for (const q of this.alive) {
            if ((this.game.nameOf(q) || '').indexOf(m[1]) >= 0) return this.isFriend(q) ? 'yes' : 'no';
          }
        }
        return 'no';
      }
      // 攻心：敌人红桃牌直接弃置
      if (/【攻心】：展示/.test(reason) && has('discard') && has('top')) return 'discard';
      // 荐言：声明基本牌（牌堆里最多、最通用）
      if (/【荐言】：请声明/.test(reason)) return has('basic') ? 'basic' : ids[0];
      // 变体回合内触发技：默认发动（免费收益）
      if (/【(?:替身|勤学|潜心|利驭|连营|诛害)/.test(reason) && (has('yes') || has('no'))) return 'yes';
      // 多选一
      if (has('hp') && has('weapon')) {
        if (p.hp <= 1) return 'weapon';
        const w = p.equips.weapon;
        return (w && (EQUIP_VALUE[w.name] || 4) <= 5) ? 'weapon' : 'hp';
      }
      if (has('heal') && has('draw')) return p.hp < p.maxHp ? 'heal' : 'draw';
      if (has('discard') && has('damage')) return (p.hp >= 3 || p.hand.length >= 4) ? 'discard' : 'damage';
      if (has('discard') && has('skip')) return this.pickBasicForXiangle() ? 'discard' : 'skip';
      // 英魂：摸 X 弃 1 或摸 1 弃 X，X>=2 时前者净赚
      if (/英魂/.test(reason) && has('draw') && has('discard')) return 'draw';
      if (has('discard') && has('draw')) return p.hand.length ? 'discard' : 'draw';
      if (has('draw') && has('play') && has('no')) return 'no';

      if (has('yes') || has('no')) return this.optionYesNo(reason, req) ? 'yes' : 'no';
      return ids[0] == null ? null : ids[0];
    }

    optionYesNo(reason, req) {
      const g = this.game, p = this.p;
      // 神速：跳过判定+摸牌换一刀，只在能斩杀时值得
      if (/神速/.test(reason)) {
        const targets = g.legalTargetsFor(p, 'sha', null).map((s2) => g.players[s2]).filter(Boolean);
        return targets.some((q) => this.isEnemy(q) && q.hp <= 1);
      }
      // 悲歌：判定对友方有利才弃牌
      if (/悲歌/.test(reason)) {
        const m = /令 (.+?) 判定/.exec(reason);
        if (m) {
          for (const q of this.alive) {
            if (g.nameOf(q) === m[1] || (g.nameOf(q) || '').indexOf(m[1]) >= 0) return this.isFriend(q);
          }
        }
        return true;
      }
      // 救援（界孙权主公技）：只有主公是友方才把回复转给主公
      if (/救援/.test(reason)) {
        const lord = g.lord;
        return !!lord && this.isFriend(lord);
      }
      // 变体触发/觉醒技：默认发动
      if (/替身|勤学|潜心|利驭|连营|诛害/.test(reason)) return true;
      // 免费/纯收益
      if (/铁骑|烈弓|猛进|麒麟弓|八卦阵|八阵|天香|刚烈|遗计|奸雄|反馈|洛神|双雄|行殇|雷击|涅槃|固政/.test(reason)) return true;
      if (/青龙偃月刀/.test(reason)) return true;
      if (/贯石斧/.test(reason)) return p.hand.length >= 5;
      if (/寒冰剑/.test(reason)) return p.hand.length >= 6 && p.hp >= 3;
      if (/颂威/.test(reason)) {
        const lord = g.lord;
        return !!lord && this.isFriend(lord);
      }
      if (/暴虐/.test(reason)) {
        const lord = g.lord;
        return !!lord && this.isFriend(lord);
      }
      if (/节命/.test(reason)) {
        return this.alive.some((q) => q.hand.length < Math.min(q.maxHp, 5) && (q.seat === p.seat || this.isFriend(q)));
      }
      if (/放逐/.test(reason)) return this.alive.some((q) => q.seat !== p.seat && this.isEnemy(q));
      if (/好施/.test(reason)) return p.hand.length <= 2;
      if (/再起/.test(reason)) return p.maxHp - p.hp >= 2;
      if (/据守/.test(reason)) return p.hp <= 2 && p.hand.length <= 2;
      if (/崩坏/.test(reason)) return p.hp <= 2; // 少掉血，选择降体力上限
      if (/英魂/.test(reason)) {
        const lost = p.maxHp - p.hp;
        return lost >= 2 || this.alive.some((q) => q.seat !== p.seat && this.isFriend(q) && q.hand.length === 0);
      }
      if (/裸衣/.test(reason)) return p.hand.some((c) => ['sha', 'huosha', 'leisha'].includes(c.name));
      if (/突袭/.test(reason)) return this.alive.some((q) => q.seat !== p.seat && this.isEnemy(q) && q.hand.length > 0);
      if (/克己/.test(reason)) return true;
      return true;
    }

    pickBasicForXiangle() {
      const basics = this.p.hand.filter((c) => c.type === 'basic');
      if (!basics.length) return false;
      return basics.some((c) => c.name !== 'tao') || this.p.hand.length >= 5;
    }

    shouldDoubt(reason) {
      // reason 里含施蛊者名字；敌方的蛊惑倾向于质疑
      for (const q of this.alive) {
        const nm = this.game.nameOf(q);
        if (nm && reason.includes(nm)) {
          if (q.seat === this.p.seat) return false;
          return this.isEnemy(q) ? this.chance(0.5) : false;
        }
      }
      return this.chance(0.4);
    }

    chooseCardFrom(req) {
      const g = this.game;
      const choices = req.choices || [];
      if (!choices.length) return null;
      const target = req.target;
      const friend = target ? (target.seat === this.p.seat || this.isFriend(target)) : false;
      const hands = choices.filter((c) => c.zone === 'hand');
      const eqs = choices.filter((c) => c.zone === 'equip');
      const judges = choices.filter((c) => c.zone === 'judge');
      const cfromReason = req.reason || '';
      // 利驭：拿装备会触发由对方指定的【决斗】，优先拿手牌/判定牌
      if (/利驭/.test(cfromReason) && target && !friend) {
        if (hands.length) return { zone: 'hand' };
        if (judges.length) return { zone: 'judge', cardId: judges[0].card.id };
        if (eqs.length) return { zone: 'equip', slot: eqs[0].slot };
      }

      if (target && !friend) {
        // 敌方：优先拆高价值装备；不要拆掉敌人判定区的乐/兵粮
        if (eqs.length) {
          const best = eqs.slice().sort((a, b) => (EQUIP_VALUE[b.card && b.card.name] || 0) - (EQUIP_VALUE[a.card && a.card.name] || 0))[0];
          if (best) return { zone: 'equip', slot: best.slot };
        }
        if (hands.length) return { zone: 'hand' };
        return { zone: 'judge', cardId: judges[0].card.id };
      }
      if (target && friend) {
        const bad = judges.find((c) => c.card && HARM_JUDGE.includes(c.card.name));
        if (bad) return { zone: 'judge', cardId: bad.card.id };
        if (hands.length) return { zone: 'hand' };
        if (eqs.length) {
          const worst = eqs.slice().sort((a, b) => (EQUIP_VALUE[a.card && a.card.name] || 0) - (EQUIP_VALUE[b.card && b.card.name] || 0))[0];
          if (worst) return { zone: 'equip', slot: worst.slot };
        }
      }
      if (hands.length) return { zone: 'hand' };
      if (eqs.length) return { zone: 'equip', slot: eqs[0].slot };
      if (judges.length) return { zone: 'judge', cardId: judges[0].card.id };
      return null;
    }

    arrange(req) {
      const cards = (req.cards || []).slice();
      const sorted = cards.slice().sort((a, b) => valueOf(b) - valueOf(a) || a.id - b.id);
      const topN = Math.min(2, sorted.length);
      return { top: sorted.slice(0, topN), bottom: sorted.slice(topN) };
    }

    pickFrom(req) {
      const cards = (req.cards || []).slice();
      if (!cards.length) return null;
      const sorted = cards.slice().sort((a, b) => valueOf(b) - valueOf(a) || a.id - b.id);
      return sorted[0].id;
    }

    distribute(req) {
      const p = this.p;
      const cards = req.cards || [];
      if (!cards.length) return [];
      // 遗计：自己留着最稳；若自己手牌已很多，给最缺牌的友方
      let target = p;
      if (p.hand.length >= 4) {
        const friends = (req.candidates || []).map((s) => this.game.players[s])
          .filter((q) => q && q.alive && q.seat !== p.seat && this.isFriend(q))
          .sort((x, y) => this.healNeed(y) - this.healNeed(x));
        if (friends.length) target = friends[0];
      }
      return cards.map((c) => ({ cardId: c.id, seat: target.seat }));
    }

    // ---------------- 小工具 ----------------
    shaLikeCount() {
      const p = this.p;
      let n = 0;
      for (const c of [...p.hand, ...Object.values(p.equips).filter(Boolean)]) {
        if (['sha', 'huosha', 'leisha'].includes(c.name)) n++;
        else if (c.name === 'shan' && p.skills.includes('longdan')) n++;
        else if (c.color === 'red' && p.skills.includes('wusheng')) n++;
      }
      return n;
    }
    shanCount() {
      const p = this.p;
      let n = 0;
      for (const c of p.hand) {
        if (c.name === 'shan') n++;
        else if (c.name === 'sha' && p.skills.includes('longdan')) n++;
        else if (c.color === 'black' && p.skills.includes('qingguo')) n++;
      }
      return n;
    }
  }

  // 供文档/调试使用（不改变调用契约）
  AI.LEVELS = Object.keys(LEVELS);
  AI.VERSION = 'ai-2026.11';

  SGS.AI = AI;
})(typeof window !== 'undefined' ? window : globalThis);
