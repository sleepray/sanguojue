/* 三国杀 · 单机版 — 武将技能
 * 分为：出牌阶段主动技 / 触发技钩子 / 转化与被动（在 cards.js 中判定）
 */
(function (global) {
  'use strict';
  const D = global.SGS_DATA;
  const { CARDS, SKILLS } = D;
  const Game = global.SGS.Game;

  const has = (p, s) => p && p.alive && p.skills.includes(s) && !(p.flags && p.flags.noSkills && !(SKILLS[s] && SKILLS[s].locked));

  Object.assign(Game.prototype, {
    // ================= 判定改判：鬼才 / 鬼道 =================
    async skillGuicai(p, who, card, reason) {
      if (p.skills.includes('guicai')) {
        const opts = p.hand.map((c) => ({ cardId: c.id, label: this.cardText(c) }));
        const res = await this.ask(p, {
          type: 'response', player: p, need: 'guicai', options: opts,
          reason: `【鬼才】：是否打出一张手牌替换 ${this.cardText(card)}？`,
        });
        if (res && res.cardId != null) {
          const c = p.hand.find((x) => x.id === res.cardId);
          if (c) { p.hand = p.hand.filter((x) => x.id !== c.id); this.afterLoseCards(p, [c]); return c; }
        }
      }
      // 鬼才（司马懿 Po）：可用手牌或装备区的任意一张牌替换判定牌
      if (p.skills.includes('j_guicai')) {
        const pool = [...p.hand, ...Object.values(p.equips).filter(Boolean)];
        const opts = pool.map((c) => ({ cardId: c.id, label: this.cardText(c) }));
        if (!opts.length) return null;
        const res = await this.ask(p, {
          type: 'response', player: p, need: 'guicai', options: opts,
          reason: `【鬼才】：是否用一张牌替换 ${this.cardText(card)}？`,
        });
        if (res && res.cardId != null) {
          const c = this.findCard(p, res.cardId);
          if (c) { this.removeAnyCard(p, c.id); this.afterLoseCards(p, [c]); return c; }
        }
      }
      if (p.skills.includes('guidao')) {
        // 鬼道可用手牌或装备区的黑色牌（官方：打出一张黑色牌）
        const pool = [...p.hand, ...Object.values(p.equips).filter(Boolean)].filter((c) => this.colorOf(p, c) === 'black');
        const opts = pool.map((c) => ({ cardId: c.id, label: this.cardText(c) }));
        if (!opts.length) return null;
        const res = await this.ask(p, {
          type: 'response', player: p, need: 'guidao', options: opts,
          reason: `【鬼道】：是否打出一张黑色牌替换 ${this.cardText(card)}？`,
        });
        if (res && res.cardId != null) {
          const c = this.findCard(p, res.cardId);
          if (c) { this.removeAnyCard(p, c.id); this.toDiscard([c]); this.afterLoseCards(p, [c]); return c; }
        }
      }
      return null;
    },

    // ================= 准备阶段 =================
    async skillGuanxing(p) {
      const n = Math.min(this.alivePlayers.length, 5);
      const cards = [];
      for (let i = 0; i < n; i++) { if (this.deck.length === 0) this.reshuffle(); if (this.deck.length) cards.push(this.deck.pop()); }
      if (!cards.length) return;
      const res = await this.ask(p, { type: 'arrange', player: p, cards, reason: `【观星】：观看牌堆顶 ${cards.length} 张牌，决定置于牌堆顶或牌堆底` });
      const top = (res && res.top) || [], bottom = (res && res.bottom) || [];
      for (let i = bottom.length - 1; i >= 0; i--) this.deck.unshift(bottom[i]);
      for (let i = top.length - 1; i >= 0; i--) this.deck.push(top[i]);
      this.log(`${this.nameOf(p)} 发动【观星】：${top.length} 张置顶，${bottom.length} 张置底`, 'skill');
      this.emit();
    },

    async skillLuoshen(p, variant) {
      this.log(`${this.nameOf(p)} 发动【洛神】`, 'skill');
      this.emit();
      let guard = 0;
      while (guard++ < 8) {
        const res = await this.judge(p, '洛神');
        const c = res.card;
        if (c && c.color === 'black') {
          if (!p.hand.some((x) => x.id === c.id)) {
            this.discardPile = this.discardPile.filter((x) => x.id !== c.id);
            p.hand.push(c); this.afterCardGain(p, [c]);
            if (variant) {
              p.flags = p.flags || {};
              p.flags.luoshenIds = p.flags.luoshenIds || [];
              p.flags.luoshenIds.push(c.id);
            }
          }
          this.log(`${this.nameOf(p)} 获得 ${this.cardText(c)}，可以继续发动洛神`, 'skill');
          this.emit();
          const r = await this.askOption(p, '是否继续发动【洛神】？', ['yes', 'no'], ['继续', '停止']);
          if (r !== 'yes') break;
        } else break;
      }
    },

    // 观星（诸葛亮 Po）：观看 5 张（存活<4 时 3 张）
    async skillGuanxingJ(p) {
      const n = this.alivePlayers.length < 4 ? 3 : 5;
      const cards = [];
      for (let i = 0; i < n; i++) { if (this.deck.length === 0) this.reshuffle(); if (this.deck.length) cards.push(this.deck.pop()); }
      if (!cards.length) return;
      const res = await this.ask(p, { type: 'arrange', player: p, cards, reason: `【观星】：观看牌堆顶 ${cards.length} 张牌，决定置于牌堆顶或牌堆底` });
      const top = (res && res.top) || [], bottom = (res && res.bottom) || [];
      for (let i = bottom.length - 1; i >= 0; i--) this.deck.unshift(bottom[i]);
      for (let i = top.length - 1; i >= 0; i--) this.deck.push(top[i]);
      p.flags = p.flags || {};
      p.flags.guanxingAllBottom = top.length === 0;
      this.log(`${this.nameOf(p)} 发动【观星】：${top.length} 张置顶，${bottom.length} 张置底`, 'skill');
      this.emit();
    },

    // 勤学（吕蒙 Po，觉醒技）：减少 1 点体力上限，回复 1 点或摸两张，获得【攻心】
    async awakenQinxue(p) {
      const r = await this.askOption(p, '【勤学】（觉醒技）：是否减少 1 点体力上限，回复 1 点体力或摸两张牌，并获得【攻心】？', ['yes', 'no'], ['发动', '不发动']);
      if (r !== 'yes') return;
      p.once.qinxue = true;
      p.skills = p.skills.filter((s) => s !== 'j_qinxue');
      p.maxHp = Math.max(1, p.maxHp - 1);
      const ch = await this.askOption(p, '【勤学】：回复 1 点体力，或摸两张牌？', ['heal', 'draw'], ['回复 1 点体力', '摸两张牌']);
      if (ch === 'heal') await this.recover(p, 1, p, '勤学');
      else this.drawCards(p, 2, '勤学');
      if (!p.skills.includes('gongxin')) p.skills.push('gongxin');
      this.log(`${this.nameOf(p)} 觉醒【勤学】，体力上限 -1，获得【攻心】`, 'skill');
      this.emit();
    },

    // 仁德（刘备 界）：本阶段给出第二张牌时，可视为使用一张基本牌（杀有次数限制）
    async rendeVirtualBasic(p) {
      const opts = [];
      if (this.canUseSlash(p) && this.legalTargetsFor(p, 'sha', null).length) opts.push({ id: 'sha', label: '视为使用【杀】' });
      if (p.hp < p.maxHp) opts.push({ id: 'tao', label: '视为使用【桃】' });
      if (!(p.drank >= 1)) opts.push({ id: 'jiu', label: '视为使用【酒】' });
      if (!opts.length) return;
      opts.push({ id: 'no', label: '不使用' });
      const ch = await this.ask(p, { type: 'chooseOption', player: p, reason: '【仁德】：本阶段已给出第二张牌，是否视为使用一张基本牌？', options: opts });
      if (!ch || ch === 'no') return;
      const vc = { id: -23, name: ch, type: 'basic', subtype: null, nature: 'normal', suit: 'none', rank: 0, color: 'none', cards: [] };
      if (ch === 'sha') {
        const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: '仁德：选择【杀】的目标', candidates: this.legalTargetsFor(p, 'sha', null), min: 1, max: 1 });
        const t = ts && this.players[ts[0]];
        if (!t) return;
        this.table.push(vc);
        await this.resolveSlash(p, vc, [t]);
        this.table = this.table.filter((c) => c !== vc);
      } else if (ch === 'tao') {
        this.table.push(vc);
        await this.resolveTao(p, vc, p);
        this.table = this.table.filter((c) => c !== vc);
      } else {
        p.drank = (p.drank || 0) + 1;
      }
      this.log(`${this.nameOf(p)} 发动【仁德】，视为使用【${ch === 'sha' ? '杀' : ch === 'tao' ? '桃' : '酒'}】`, 'skill');
      this.emit();
    },

    // ================= 出牌阶段主动技 =================
    buildSkillActions(p, push) {
      const once = (k) => !p.used[k];
      if (has(p, 'rende')) {
        push({ kind: 'skill', skill: 'rende', label: '仁德：交给其他角色任意张手牌', needsCards: { min: 1, max: 99 }, targetCandidates: this.alivePlayers.filter((q) => q.seat !== p.seat).map((q) => q.seat), minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'j_rende')) {
        const given = p.flags.rendeGiven || {};
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && !given[q.seat]).map((q) => q.seat);
        if (cands.length && p.hand.length) push({ kind: 'skill', skill: 'j_rende', label: '仁德（界）：交给一名其他角色任意张手牌（每名角色限一次）', needsCards: { min: 1, max: 99 }, targetCandidates: cands, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'zhiheng') && once('zhiheng')) {
        push({ kind: 'skill', skill: 'zhiheng', label: '制衡：弃任意张牌摸等量（限一次）', needsCards: { min: 1, max: 99 } });
      }
      if (has(p, 'j_zhiheng') && once('j_zhiheng')) {
        push({ kind: 'skill', skill: 'j_zhiheng', label: '制衡（界）：弃任意张牌摸等量，弃光手牌额外摸 1（限一次）', needsCards: { min: 1, max: 99 } });
      }
      if (has(p, 'kurou')) {
        push({ kind: 'skill', skill: 'kurou', label: '苦肉：失去 1 点体力摸两张牌' });
      }
      if (has(p, 'j_kurou') && once('j_kurou') && p.hand.length) {
        push({ kind: 'skill', skill: 'j_kurou', label: '苦肉（界）：弃置一张手牌，然后失去 1 点体力', needsCards: { min: 1, max: 1 } });
      }
      if (has(p, 'gongxin') && once('gongxin')) {
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && q.hand.length).map((q) => q.seat);
        if (cands.length) push({ kind: 'skill', skill: 'gongxin', label: '攻心：观看一名其他角色的手牌，可展示一张红桃牌弃置或置于牌堆顶', targetCandidates: cands, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'shizhan') && (p.used.shizhan || 0) < 2) {
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat).map((q) => q.seat);
        if (cands.length) push({ kind: 'skill', skill: 'shizhan', label: '势斩：令一名其他角色视为对你使用【决斗】（限两次）', targetCandidates: cands, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'qingnang') && once('qingnang')) {
        const wounded = this.alivePlayers.filter((q) => q.hp < q.maxHp).map((q) => q.seat);
        if (wounded.length) push({ kind: 'skill', skill: 'qingnang', label: '青囊：弃一张手牌令一名角色回复 1 点体力', needsCards: { min: 1, max: 1 }, targetCandidates: wounded, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'jianyan') && once('jianyan')) {
        const males = this.alivePlayers.filter((q) => q.gender === 'male');
        if (males.length) push({ kind: 'skill', skill: 'jianyan', label: '荐言：声明牌型或颜色，将牌堆顶第一张符合的牌交给一名男性角色' });
      }
      if (has(p, 'fanjian') && once('fanjian')) {
        push({ kind: 'skill', skill: 'fanjian', label: '反间：令一名角色选择花色并获得你一张手牌', needsCards: { min: 1, max: 1 }, targetCandidates: this.alivePlayers.filter((q) => q.seat !== p.seat).map((q) => q.seat), minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'j_fanjian') && once('j_fanjian') && p.hand.length) {
        push({ kind: 'skill', skill: 'j_fanjian', label: '反间（界）：交给一名其他角色一张手牌，其弃置同花色或失去 1 点体力', needsCards: { min: 1, max: 1 }, targetCandidates: this.alivePlayers.filter((q) => q.seat !== p.seat).map((q) => q.seat), minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'j_yijue') && once('j_yijue') && (p.hand.length || Object.values(p.equips).some(Boolean))) {
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && q.hand.length).map((q) => q.seat);
        if (cands.length) {
          const act2 = { kind: 'skill', skill: 'j_yijue', label: '义绝：弃一张牌令其展示手牌；黑色则非锁定技失效/不能用手牌，红色则获得之并可令其回血', targetCandidates: cands, minTargets: 1, maxTargets: 1 };
          if (p.hand.length) act2.needsCards = { min: 1, max: 1 };
          push(act2);
        }
      }
      if (has(p, 'j_guose') && once('j_guose') && p.hand.some((c) => this.suitOf(p, c) === 'diamond')) {
        push({ kind: 'skill', skill: 'j_guose', label: '国色（界）：方块当【乐不思蜀】，或弃方块+场上【乐不思蜀】，然后摸一张', needsCards: { min: 1, max: 1 } });
      }
      if (has(p, 'j_jieyin') && once('j_jieyin') && (p.hand.length || Object.values(p.equips).some(Boolean))) {
        const males = this.alivePlayers.filter((q) => q.seat !== p.seat && q.gender === 'male').map((q) => q.seat);
        if (males.length) push({ kind: 'skill', skill: 'j_jieyin', label: '结姻（界）：弃手牌或置入装备，体力大者摸一张、小者回复 1 点', targetCandidates: males, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'j_shidu') && once('j_shidu')) {
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && q.hand.length).map((q) => q.seat);
        if (cands.length && p.hand.length) push({ kind: 'skill', skill: 'j_shidu', label: '识度：拼点，赢则获得其所有手牌并交回一半（向下取整）', targetCandidates: cands, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'j_choufa') && once('j_choufa')) {
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && q.hand.length).map((q) => q.seat);
        if (cands.length) push({ kind: 'skill', skill: 'j_choufa', label: '筹伐：展示其一张手牌，其不同类型手牌视为【杀】直到其回合结束', targetCandidates: cands, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'j_yanxi') && once('j_yanxi')) {
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && q.hand.length).map((q) => q.seat);
        if (cands.length) push({ kind: 'skill', skill: 'j_yanxi', label: '宴戏：混合其一张手牌与牌堆顶两张，猜中得全部三张', targetCandidates: cands, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'j_sanchen') && once('j_sanchen')) {
        const banned = p.flags.sanchenBanned || [];
        const cands = this.alivePlayers.filter((q) => banned.indexOf(q.seat) < 0).map((q) => q.seat);
        if (cands.length) push({ kind: 'skill', skill: 'j_sanchen', label: '三陈：令一名角色摸三弃三；类型均不同则摸一且技能视为未发动', targetCandidates: cands, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'j_chuli') && once('j_chuli') && p.hand.length) {
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && this.allCardsOf(q).length).map((q) => q.seat);
        if (cands.length) push({ kind: 'skill', skill: 'j_chuli', label: '除疠：选择势力各不相同的其他角色，弃置你与其各一张牌（黑桃摸牌）', targetCandidates: cands, minTargets: 1, maxTargets: Math.min(4, new Set(this.alivePlayers.filter((q) => q.seat !== p.seat && this.allCardsOf(q).length).map((q) => q.kingdom)).size) });
      }
      if (has(p, 'lijian') && once('lijian')) {
        const males = this.alivePlayers.filter((q) => q.gender === 'male' && !(q.skills.includes('kongcheng') && q.hand.length === 0)).map((q) => q.seat);
        if (males.length >= 2 && this.selectableCards(p).length) push({ kind: 'skill', skill: 'lijian', label: '离间：弃一张牌（手牌或装备）令两名男性角色决斗', targetCandidates: males, minTargets: 2, maxTargets: 2, ordered: true });
      }
      if (has(p, 'jieyin') && once('jieyin')) {
        const woundedMale = this.alivePlayers.filter((q) => q.seat !== p.seat && q.gender === 'male' && q.hp < q.maxHp).map((q) => q.seat);
        if (woundedMale.length) push({ kind: 'skill', skill: 'jieyin', label: '结姻：弃两张手牌，你与一名受伤男性各回复 1 点', needsCards: { min: 2, max: 2 }, targetCandidates: woundedMale, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'jijiang') && p.role === 'lord' && this.canUseSlash(p)) {
        const targets = this.alivePlayers.filter((q) => q.seat !== p.seat && q.kingdom === '蜀').map((q) => q.seat);
        const inRange = this.legalTargetsFor(p, 'sha', null);
        if (targets.length && inRange.length) {
          push({ kind: 'skill', skill: 'jijiang', label: '激将：令其他蜀势力角色替你使用【杀】', targetCandidates: inRange, minTargets: 1, maxTargets: 1 });
        }
      }
      // 以下为扩展包主动技
      if (has(p, 'qiangxi') && once('qiangxi')) {
        const targets = this.alivePlayers.filter((q) => q.seat !== p.seat && this.inAttackRange(p, q)).map((q) => q.seat);
        if (targets.length) push({ kind: 'skill', skill: 'qiangxi', label: '强袭：失去 1 点体力或弃武器，对攻击范围内角色造成 1 点伤害', targetCandidates: targets, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'quhu') && once('quhu')) {
        const targets = this.alivePlayers.filter((q) => q.seat !== p.seat && q.hp > p.hp).map((q) => q.seat);
        if (targets.length) push({ kind: 'skill', skill: 'quhu', label: '驱虎：与一名体力高于你的角色拼点', targetCandidates: targets, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'tianyi') && once('tianyi') && !p.flags.tianyiLose) {
        const targets = this.alivePlayers.filter((q) => q.seat !== p.seat).map((q) => q.seat);
        if (targets.length) push({ kind: 'skill', skill: 'tianyi', label: '天义：与一名角色拼点，赢则本回合额外【杀】且无距离', targetCandidates: targets, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'luanji')) {
        const bySuit = {};
        for (const c of p.hand) (bySuit[c.suit] = bySuit[c.suit] || []).push(c);
        if (Object.values(bySuit).some((a) => a.length >= 2)) {
          push({ kind: 'skill', skill: 'luanji', label: '乱击：两张同花色手牌当【万箭齐发】', needsCards: { min: 2, max: 2 }, sameSuit: true });
        }
      }
      if (has(p, 'tiaoxin') && once('tiaoxin')) {
        const targets = this.alivePlayers.filter((q) => q.seat !== p.seat && this.inAttackRange(q, p)).map((q) => q.seat);
        if (targets.length) push({ kind: 'skill', skill: 'tiaoxin', label: '挑衅：令一名角色对你使用【杀】，否则你弃其一张牌', targetCandidates: targets, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'fangquan') && !p.flags.fangquan && p.hand.length) {
        push({ kind: 'skill', skill: 'fangquan', label: '放权：跳过出牌阶段，本回合结束时弃一张手牌令一名其他角色获得额外回合', targetCandidates: this.alivePlayers.filter((q) => q.seat !== p.seat).map((q) => q.seat), minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'zhijian')) {
        push({ kind: 'skill', skill: 'zhijian', label: '直谏：将一张手牌置入其他角色装备区，然后摸一张', needsCards: { min: 1, max: 1 }, targetCandidates: this.alivePlayers.filter((q) => q.seat !== p.seat).map((q) => q.seat), minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'luanwu') && !p.once.luanwu) {
        push({ kind: 'skill', skill: 'luanwu', label: '乱武（限定技）：所有其他角色对最近角色使用【杀】或失去 1 点体力' });
      }
      if (has(p, 'niepan') && !p.once.niepan) {
        // 涅槃只在濒死时使用，不列入常规动作
      }
      if (has(p, 'tuntian')) { /* 失去牌时判定，见 afterLoseCards */ }
      if (has(p, 'jixi') && (p.marks.tian || 0) > 0) {
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && this.allCardsOf(q).length && this.distance(p, q) <= 1).map((q) => q.seat);
        if (cands.length) push({ kind: 'skill', skill: 'jixi', label: '急袭：将一张「田」当【顺手牵羊】', targetCandidates: cands, minTargets: 1, maxTargets: 1 });
      }
      if (has(p, 'guhuo') && p.hand.length) {
        push({ kind: 'skill', skill: 'guhuo', label: '蛊惑：声明一张基本牌或普通锦囊，扣置一张手牌', needsCards: { min: 1, max: 1 } });
      }
      if (p.kingdom === '吴' && p.role !== 'lord' && !p.used.zhiba) {
        const lord = this.lord;
        if (lord && lord.alive && lord.skills.includes('zhiba')) push({ kind: 'skill', skill: 'zhiba', label: '制霸：与主公孙策拼点', targetCandidates: [lord.seat], minTargets: 1, maxTargets: 1 });
      }
      // 黄天（主公技）：其他群势力角色把【闪】/【闪电】交给主公张角（出牌阶段限一次）
      if (p.kingdom === '群' && p.role !== 'lord' && !p.used.huangtian && p.hand.some((c) => c.name === 'shan' || c.name === 'shandian')) {
        const lord = this.lord;
        if (lord && lord.alive && lord.seat !== p.seat && lord.skills.includes('huangtian')) {
          push({ kind: 'skill', skill: 'huangtian', label: '黄天：将一张【闪】或【闪电】交给张角', needsCards: { min: 1, max: 1 } });
        }
      }
      // 缔盟：仅在存在“有牌差且付得起”的目标组合时给出入口
      if (has(p, 'dimeng') && once('dimeng')) {
        const others = this.alivePlayers.filter((q) => q.seat !== p.seat);
        const pay = this.selectableCards(p).length;
        let ok = false;
        for (let i = 0; i < others.length && !ok; i++) for (let j = i + 1; j < others.length; j++) {
          const diff = Math.abs(others[i].hand.length - others[j].hand.length);
          if (diff > 0 && diff <= pay) { ok = true; break; }
        }
        if (ok) push({ kind: 'skill', skill: 'dimeng', label: '缔盟：弃 X 张牌交换两名其他角色的手牌（X 为手牌数之差）', targetCandidates: others.map((q) => q.seat), minTargets: 2, maxTargets: 2 });
      }
      if (has(p, 'huashen')) this.initHuashen(p);
    },


    async useSkillAction(p, act) {
      const S = act.skill;
      const cards = (act.cards || []).map((id) => p.hand.find((c) => c.id === id)).filter(Boolean);
      const targets = (act.targets || []).map((s2) => this.players[s2]);
      switch (S) {
        case 'rende': {
          if (!cards.length) return;
          p.hand = p.hand.filter((c) => !cards.some((x) => x.id === c.id));
          targets[0].hand.push(...cards);
          for (const c of cards) this.afterCardGain(targets[0], [c]);
          await this.afterLoseCards(p, cards, true);
          p.givenRende = (p.givenRende || 0) + cards.length;
          this.log(`${this.nameOf(p)} 发动【仁德】交给 ${this.nameOf(targets[0])} ${cards.length} 张牌`, 'skill');
          if (p.givenRende >= 2 && !p.flags.rendeHealed) { p.flags.rendeHealed = true; await this.recover(p, 1, p, '仁德'); }
          this.emit();
          return;
        }
        case 'j_rende': {
          const t = targets[0];
          if (!cards.length || !t) return;
          p.flags = p.flags || {};
          p.flags.rendeGiven = p.flags.rendeGiven || {};
          if (p.flags.rendeGiven[t.seat]) { this.log(`【仁德】本阶段已对 ${this.nameOf(t)} 发动过`, 'info'); return; }
          p.hand = p.hand.filter((c) => !cards.some((x) => x.id === c.id));
          t.hand.push(...cards);
          for (const c of cards) this.afterCardGain(t, [c]);
          await this.afterLoseCards(p, cards, true);
          p.flags.rendeGiven[t.seat] = true;
          const prev = p.flags.rendeCount || 0;
          p.flags.rendeCount = prev + cards.length;
          this.log(`${this.nameOf(p)} 发动【仁德】交给 ${this.nameOf(t)} ${cards.length} 张牌`, 'skill');
          this.emit();
          if (prev < 2 && p.flags.rendeCount >= 2) await this.rendeVirtualBasic(p);
          return;
        }
        case 'zhiheng': {
          if (!cards.length) return;
          p.used.zhiheng = true;
          p.hand = p.hand.filter((c) => !cards.some((x) => x.id === c.id));
          this.toDiscard(cards);
          await this.afterLoseCards(p, cards);
          this.drawCards(p, cards.length, '制衡');
          this.log(`${this.nameOf(p)} 发动【制衡】弃 ${cards.length} 张摸 ${cards.length} 张`, 'skill');
          return;
        }
        case 'j_zhiheng': {
          if (!cards.length) return;
          p.used.j_zhiheng = true;
          const allHand = cards.length === p.hand.length;
          p.hand = p.hand.filter((c) => !cards.some((x) => x.id === c.id));
          this.toDiscard(cards);
          await this.afterLoseCards(p, cards);
          const n = cards.length + (allHand ? 1 : 0);
          this.drawCards(p, n, '制衡');
          this.log(`${this.nameOf(p)} 发动【制衡（界）】弃 ${cards.length} 张摸 ${n} 张${allHand ? '（弃光手牌额外摸 1）' : ''}`, 'skill');
          return;
        }
        case 'kurou': {
          this.log(`${this.nameOf(p)} 发动【苦肉】`, 'skill');
          await this.loseHp(p, 1, '苦肉');
          if (p.alive) this.drawCards(p, 2, '苦肉');
          return;
        }
        case 'j_kurou': {
          if (!cards.length) return;
          p.used.j_kurou = true;
          p.hand = p.hand.filter((c) => !cards.some((x) => x.id === c.id));
          this.toDiscard(cards);
          await this.afterLoseCards(p, cards);
          this.log(`${this.nameOf(p)} 发动【苦肉（界）】弃置 ${cards.length} 张牌`, 'skill');
          await this.loseHp(p, 1, '苦肉');
          return;
        }
        case 'gongxin': {
          const t = targets[0];
          if (!t || !t.hand.length) return;
          p.used.gongxin = true;
          this.log(`${this.nameOf(p)} 发动【攻心】观看 ${this.nameOf(t)} 的手牌：${t.hand.map((c) => this.cardText(c)).join('、')}`, 'skill');
          this.emit();
          const hearts = t.hand.filter((c) => this.suitOf(t, c) === 'heart');
          if (!hearts.length) return;
          const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: '攻心：选择一张红桃牌展示', cards: hearts, min: 1, max: 1 });
          const c = sel && sel.length ? this.findCard(t, sel[0].id) : null;
          if (!c) return;
          const opt = await this.askOption(p, `【攻心】：展示 ${this.cardText(c)}，弃置此牌还是置于牌堆顶？`, ['discard', 'top'], ['弃置', '置于牌堆顶']);
          t.hand = t.hand.filter((x) => x.id !== c.id);
          if (opt === 'top') this.deck.push(c);
          else { this.toDiscard([c]); await this.afterLoseCards(t, [c]); }
          this.log(`${this.nameOf(p)} 发动【攻心】：${opt === 'top' ? '将' : '弃置'} ${this.cardText(c)}${opt === 'top' ? '置于牌堆顶' : ''}`, 'skill');
          this.emit();
          return;
        }
        case 'shizhan': {
          const t = targets[0];
          if (!t || !t.alive) return;
          p.used.shizhan = (p.used.shizhan || 0) + 1;
          const vc = { id: -22, name: 'juedou', type: 'trick', subtype: null, nature: 'normal', suit: 'none', rank: 0, color: 'none', cards: [] };
          this.log(`${this.nameOf(p)} 发动【势斩】，令 ${this.nameOf(t)} 视为对其使用【决斗】`, 'skill');
          this.table.push(vc);
          await this.resolveDuel(t, vc, p);
          this.table = this.table.filter((c) => c !== vc);
          return;
        }
        case 'j_shidu': {
          const t = targets[0];
          if (!t || !t.alive || !t.hand.length || !p.hand.length) return;
          p.used.j_shidu = true;
          const win = await this.pindian(p, t, '识度');
          if (!win) { this.log(`【识度】${this.nameOf(p)} 拼点未赢，无后续效果`, 'skill'); return; }
          const all = t.hand.splice(0);
          for (const c of all) { p.hand.push(c); this.afterCardGain(p, [c]); }
          if (all.length) await this.afterLoseCards(t, all, true);
          const give = Math.floor(p.hand.length / 2);
          if (give > 0) {
            const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: `识度：交给其 ${give} 张手牌`, cards: p.hand.slice(), min: give, max: give });
            const cs = (sel || []).slice(0, give).map((x) => this.findCard(p, x.id)).filter(Boolean);
            p.hand = p.hand.filter((c) => cs.indexOf(c) < 0);
            for (const c of cs) { t.hand.push(c); this.afterCardGain(t, [c]); }
            if (cs.length) await this.afterLoseCards(p, cs, true);
            this.log(`${this.nameOf(p)} 发动【识度】获得 ${this.nameOf(t)} 全部手牌，交回 ${cs.length} 张`, 'skill');
          } else {
            this.log(`${this.nameOf(p)} 发动【识度】获得 ${this.nameOf(t)} 全部手牌`, 'skill');
          }
          this.emit();
          return;
        }
        case 'j_choufa': {
          const t = targets[0];
          if (!t || !t.alive || !t.hand.length) return;
          p.used.j_choufa = true;
          const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: '筹伐：展示其一张手牌', cards: t.hand.slice(), min: 1, max: 1 });
          const c = sel && sel.length ? this.findCard(t, sel[0].id) : null;
          if (!c) return;
          const tp = (CARDS[c.name] || {}).type || 'basic';
          const cn = { basic: '基本牌', trick: '锦囊牌', delayed: '延时锦囊', equip: '装备牌' }[tp] || tp;
          t.marks = t.marks || {};
          t.marks.choufaType = tp;
          this.log(`${this.nameOf(p)} 发动【筹伐】展示 ${this.nameOf(t)} 的 ${this.cardText(c)}（${cn}）；其不同类型手牌视为【杀】直到其回合结束`, 'skill');
          this.emit();
          return;
        }
        case 'j_yanxi': {
          const t = targets[0];
          if (!t || !t.alive || !t.hand.length) return;
          if (this.deck.length < 2) this.reshuffle();
          if (this.deck.length < 2) return;
          p.used.j_yanxi = true;
          const handCard = t.hand[this.rand(t.hand.length)];
          t.hand = t.hand.filter((c) => c.id !== handCard.id);
          await this.afterLoseCards(t, [handCard], true);
          const c1 = this.deck.pop(), c2 = this.deck.pop();
          const cards = [handCard, c1, c2].filter(Boolean);
          this.shuffle(cards);
          this.log(`${this.nameOf(p)} 发动【宴戏】展示三张牌：${cards.map((c) => this.cardText(c)).join('、')}`, 'skill');
          const opts = cards.map((c, i) => ({ id: String(i), label: this.cardText(c) }));
          const guess = await this.ask(p, { type: 'chooseOption', player: p, reason: '宴戏：猜测哪一张来自其手牌', options: opts });
          let idx = Number(guess);
          if (!Number.isFinite(idx) || idx < 0 || idx >= cards.length) idx = 0;
          const correct = cards[idx] && cards[idx].id === handCard.id;
          const gained = correct ? cards.slice() : [cards[idx]].filter(Boolean);
          for (const c of gained) {
            p.hand.push(c);
            this.afterCardGain(p, [c]);
            p.flags = p.flags || {};
            p.flags.yanxiIds = p.flags.yanxiIds || [];
            p.flags.yanxiIds.push(c.id);
          }
          const rest = cards.filter((c) => gained.indexOf(c) < 0);
          if (rest.length) this.toDiscard(rest);
          this.log(`${this.nameOf(p)} 发动【宴戏】${correct ? '猜对，获得全部三张牌' : '猜错，获得选中的一张牌'}`, 'skill');
          this.emit();
          return;
        }
        case 'j_sanchen': {
          const t = targets[0];
          if (!t || !t.alive) return;
          p.used.j_sanchen = true;
          p.marks = p.marks || {};
          p.marks.sanchenCount = (p.marks.sanchenCount || 0) + 1;
          this.drawCards(t, 3, '三陈');
          const n = Math.min(3, t.hand.length);
          let discarded = [];
          if (n > 0) {
            const sel = await this.ask(t, { type: 'chooseCards', player: t, reason: `三陈：弃置 ${n} 张手牌`, cards: t.hand.slice(), min: n, max: n });
            discarded = (sel || []).slice(0, n).map((x) => this.findCard(t, x.id)).filter(Boolean);
            t.hand = t.hand.filter((c) => discarded.indexOf(c) < 0);
            this.toDiscard(discarded);
            await this.afterLoseCards(t, discarded);
          }
          const types = new Set(discarded.map((c) => { const d = CARDS[c.name] || {}; return d.type === 'delayed' ? 'trick' : d.type; }));
          const success = discarded.length === 3 && types.size === 3;
          if (success) {
            this.drawCards(t, 1, '三陈');
            p.used.j_sanchen = false; // 视为未发动，可再次使用
            p.flags = p.flags || {};
            p.flags.sanchenBanned = p.flags.sanchenBanned || [];
            p.flags.sanchenBanned.push(t.seat);
            this.log(`${this.nameOf(p)} 发动【三陈】：${this.nameOf(t)} 弃置三张类型均不同，摸一张；本技能视为未发动`, 'skill');
          } else {
            this.log(`${this.nameOf(p)} 发动【三陈】：${this.nameOf(t)} 摸三弃 ${discarded.length} 张`, 'skill');
          }
          this.emit();
          return;
        }
        case 'j_yijue': {
          const t = targets[0];
          if (!t || !t.alive || !t.hand.length) return;
          let cost = cards[0] || null;
          if (!cost) {
            const eqs = Object.values(p.equips).filter(Boolean).map((c) => ({ cardId: c.id, label: this.cardText(c) }));
            if (!eqs.length) return;
            const r = await this.ask(p, { type: 'response', player: p, need: 'yijueCost', options: eqs, reason: '义绝：弃置一张装备牌' });
            if (r && r.cardId != null) cost = this.findCard(p, r.cardId);
          }
          if (!cost) return;
          p.used.j_yijue = true;
          if (p.hand.some((c) => c.id === cost.id)) p.hand = p.hand.filter((c) => c.id !== cost.id);
          else this.removeAnyCard(p, cost.id);
          this.toDiscard([cost]);
          await this.afterLoseCards(p, [cost]);
          const sel = await this.ask(t, { type: 'chooseCards', player: t, reason: '义绝：请展示一张手牌', cards: t.hand.slice(), min: 1, max: 1 });
          const shown = sel && sel.length ? this.findCard(t, sel[0].id) : null;
          if (!shown) return;
          this.log(`${this.nameOf(p)} 发动【义绝】，${this.nameOf(t)} 展示 ${this.cardText(shown)}`, 'skill');
          this.emit();
          if (this.colorOf(t, shown) === 'red') {
            t.hand = t.hand.filter((c) => c.id !== shown.id);
            p.hand.push(shown);
            this.afterCardGain(p, [shown]);
            this.log(`${this.nameOf(p)} 获得 ${this.nameOf(t)} 展示的 ${this.cardText(shown)}`, 'skill');
            const r = await this.askOption(p, `【义绝】：是否令 ${this.nameOf(t)} 回复 1 点体力？`, ['yes', 'no'], ['发动', '不发动']);
            if (r === 'yes') await this.recover(t, 1, p, '义绝');
          } else {
            t.flags = t.flags || {};
            t.flags.noSkills = true;
            t.flags.noHand = true;
            p.flags = p.flags || {};
            p.flags.yijueTargets = p.flags.yijueTargets || {};
            p.flags.yijueTargets[t.seat] = true;
            this.log(`【义绝】：${this.nameOf(t)} 本回合非锁定技失效且不能使用或打出手牌；${this.nameOf(p)} 对其红桃【杀】伤害 +1`, 'skill');
          }
          this.emit();
          return;
        }
        case 'j_guose': {
          const c = cards[0];
          if (!c || this.suitOf(p, c) !== 'diamond') return;
          const lebus = [];
          for (const q of this.alivePlayers) for (const jc of q.judges) if (jc.name === 'lebu') lebus.push({ seat: q.seat, card: jc });
          const modeOpts = [{ id: 'lebu', label: '将方块牌当【乐不思蜀】使用' }];
          if (lebus.length) modeOpts.push({ id: 'remove', label: '弃置方块牌和场上一张【乐不思蜀】' });
          const mode = await this.askOption(p, '【国色】：请选择一项（结算后摸一张牌）', modeOpts.map((o) => o.id), modeOpts.map((o) => o.label));
          if (mode === 'lebu') {
            const cands = this.legalTargetsFor(p, 'lebu', null);
            if (!cands.length) return;
            const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: '国色：选择【乐不思蜀】的目标', candidates: cands, min: 1, max: 1 });
            const t = ts && this.players[ts[0]];
            if (!t) return;
            p.used.j_guose = true;
            await this.useVirtualCard(p, [c], 'lebu', 'j_guose', [t]);
            this.drawCards(p, 1, '国色');
            this.log(`${this.nameOf(p)} 发动【国色】，结算后摸一张牌`, 'skill');
            return;
          }
          if (!lebus.length) return;
          const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: '国色：选择场上一张【乐不思蜀】', candidates: lebus.map((x) => x.seat), min: 1, max: 1 });
          const entry = ts && lebus.find((x) => x.seat === ts[0]);
          if (!entry) return;
          p.used.j_guose = true;
          p.hand = p.hand.filter((x) => x.id !== c.id);
          this.toDiscard([c]);
          await this.afterLoseCards(p, [c]);
          const q = this.players[entry.seat];
          if (q) { const leb = q.judges.find((x) => x.name === 'lebu'); if (leb) { q.judges = q.judges.filter((x) => x !== leb); this.toDiscard([leb]); } }
          this.drawCards(p, 1, '国色');
          this.log(`${this.nameOf(p)} 发动【国色】弃置 ${this.cardText(c)} 和一张【乐不思蜀】，摸一张牌`, 'skill');
          return;
        }
        case 'j_jieyin': {
          const t = targets[0];
          if (!t || !t.alive || t.gender !== 'male') return;
          const eqs = Object.keys(p.equips).filter((k) => p.equips[k]);
          const hasHand = p.hand.length > 0;
          if (!hasHand && !eqs.length) return;
          let mode;
          if (hasHand && eqs.length) mode = await this.askOption(p, '【结姻】：弃置一张手牌，或将一张装备牌置入其装备区', ['hand', 'equip'], ['弃置手牌', '置入装备']);
          else mode = hasHand ? 'hand' : 'equip';
          if (mode === 'hand') {
            const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: '结姻：弃置一张手牌', cards: p.hand.slice(), min: 1, max: 1 });
            const c = sel && sel.length ? this.findCard(p, sel[0].id) : null;
            if (!c) return;
            p.hand = p.hand.filter((x) => x.id !== c.id);
            this.toDiscard([c]);
            await this.afterLoseCards(p, [c]);
          } else {
            const slot = await this.askOption(p, '【结姻】：选择要置入其装备区的装备', eqs, eqs.map((k) => ({ weapon: '武器', armor: '防具', offhorse: '坐骑-1', defhorse: '坐骑+1' }[k] || k)));
            const c = p.equips[slot];
            if (!c) return;
            p.equips[slot] = null;
            const prev = t.equips[slot];
            if (prev) { t.equips[slot] = null; this.toDiscard([prev]); await this.afterLoseCards(t, [prev]); }
            t.equips[slot] = c;
            this.afterCardGain(t, [c]);
            await this.afterLoseCards(p, [c]);
          }
          p.used.j_jieyin = true;
          if (p.hp > t.hp) { this.drawCards(p, 1, '结姻'); await this.recover(t, 1, p, '结姻'); }
          else if (t.hp > p.hp) { this.drawCards(t, 1, '结姻'); await this.recover(p, 1, p, '结姻'); }
          this.log(`${this.nameOf(p)} 发动【结姻】${p.hp === t.hp ? '双方体力相同，无摸牌/回复' : ''}`, 'skill');
          this.emit();
          return;
        }
        case 'j_chuli': {
          const seen = new Set();
          const chosen = [];
          for (const t of targets) {
            if (!t || !t.alive || seen.has(t.kingdom)) continue;
            seen.add(t.kingdom); chosen.push(t);
          }
          p.used.j_chuli = true;
          for (const t of chosen) {
            if (!p.alive) break;
            if (!p.hand.length) break;
            const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: `除疠：弃置你的一张手牌（对 ${this.nameOf(t)}）`, cards: p.hand.slice(), min: 1, max: 1 });
            const mc = sel && sel.length ? this.findCard(p, sel[0].id) : null;
            if (mc) {
              p.hand = p.hand.filter((x) => x.id !== mc.id);
              this.toDiscard([mc]);
              await this.afterLoseCards(p, [mc]);
              if (mc.suit === 'spade') this.drawCards(p, 1, '除疠');
            }
            const equipBefore = Object.values(t.equips).filter(Boolean);
            const handBefore = t.hand.length;
            const tc = await this.pickCardFrom(t, p, { zones: ['hand', 'equip', 'judge'], reason: '除疠：弃置其一张牌' });
            if (tc) {
              this.toDiscard([tc]);
              if (equipBefore.indexOf(tc) < 0) await this.afterLoseCards(t, [tc], t.hand.length === handBefore - 1);
              if (tc.suit === 'spade') this.drawCards(t, 1, '除疠');
            }
          }
          this.log(`${this.nameOf(p)} 发动【除疠】，共选择 ${chosen.length} 名不同势力角色`, 'skill');
          this.emit();
          return;
        }
        case 'j_fanjian': {
          const t = targets[0];
          if (!cards.length || !t) return;
          p.used.j_fanjian = true;
          const c = cards[0];
          p.hand = p.hand.filter((x) => x.id !== c.id);
          const suit = this.suitOf(p, c);
          t.hand.push(c);
          this.afterCardGain(t, [c]);
          await this.afterLoseCards(p, [c], true);
          this.log(`${this.nameOf(p)} 对 ${this.nameOf(t)} 发动【反间】，展示并交给 ${this.cardText(c)}（${D.SUITS[suit] ? D.SUITS[suit].name : '?'}）`, 'skill');
          this.emit();
          const opt = await this.askOption(t, '【反间】：展示所有手牌并弃置与此牌相同花色的牌，或失去 1 点体力', ['discard', 'losehp'], ['展示手牌并弃置同花色', '失去 1 点体力']);
          if (opt === 'discard') {
            this.log(`${this.nameOf(t)} 展示手牌：${t.hand.map((x) => this.cardText(x)).join('、')}`, 'info');
            const same = t.hand.filter((x) => this.suitOf(t, x) === suit);
            t.hand = t.hand.filter((x) => same.indexOf(x) < 0);
            this.toDiscard(same);
            await this.afterLoseCards(t, same);
            this.log(`${this.nameOf(t)} 因【反间】弃置 ${same.length} 张同花色牌`, 'skill');
          } else {
            await this.loseHp(t, 1, '反间');
          }
          return;
        }
        case 'qingnang': {
          if (!cards.length || !targets[0]) return;
          p.used.qingnang = true;
          p.hand = p.hand.filter((c) => !cards.some((x) => x.id === c.id));
          this.toDiscard(cards);
          await this.afterLoseCards(p, cards);
          await this.recover(targets[0], 1, p, '青囊');
          this.log(`${this.nameOf(p)} 发动【青囊】`, 'skill');
          return;
        }
        case 'jianyan': {
          p.used.jianyan = true;
          const decl = await this.askOption(p, '【荐言】：请声明一种牌的类型或颜色', ['basic', 'trick', 'equip', 'red', 'black'], ['基本牌', '锦囊牌', '装备牌', '红色', '黑色']);
          const match = (c) => {
            if (!c) return false;
            const def = CARDS[c.name] || {};
            if (decl === 'basic') return def.type === 'basic';
            if (decl === 'trick') return def.type === 'trick' || def.type === 'delayed';
            if (decl === 'equip') return def.type === 'equip';
            const color = c.color || (D.SUITS[c.suit] || {}).color;
            return color === decl;
          };
          let picked = null;
          for (let pass = 0; pass < 2 && !picked; pass++) {
            for (let i = this.deck.length - 1; i >= 0; i--) {
              if (match(this.deck[i])) { picked = this.deck.splice(i, 1)[0]; break; }
            }
            if (!picked && pass === 0) this.reshuffle();
          }
          if (!picked) { this.log(`【荐言】没有找到符合条件的牌`, 'info'); return; }
          let t = targets[0];
          if (!t || !t.alive) {
            const males = this.alivePlayers.filter((q) => q.gender === 'male').map((q) => q.seat);
            if (!males.length) { this.deck.push(picked); this.log('【荐言】场上没有男性角色，牌放回牌堆顶', 'info'); return; }
            const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: '荐言：选择获得此牌的一名男性角色', candidates: males, min: 1, max: 1 });
            t = ts && this.players[ts[0]];
          }
          if (!t || !t.alive) { this.deck.push(picked); return; }
          t.hand.push(picked);
          this.afterCardGain(t, [picked]);
          const declName = { basic: '基本牌', trick: '锦囊牌', equip: '装备牌', red: '红色', black: '黑色' }[decl] || decl;
          this.log(`${this.nameOf(p)} 发动【荐言】声明${declName}，将 ${this.cardText(picked)} 交给 ${this.nameOf(t)}`, 'skill');
          return;
        }
        case 'fanjian': {
          if (!cards.length || !targets[0]) return;
          p.used.fanjian = true;
          const suit = await this.ask(targets[0], { type: 'chooseOption', player: targets[0], reason: '【反间】：请选择一种花色', options: Object.keys(D.SUITS).map((s2) => ({ id: s2, label: D.SUITS[s2].name })) });
          const c = cards[0];
          p.hand = p.hand.filter((x) => x.id !== c.id);
          targets[0].hand.push(c);
          this.afterCardGain(targets[0], [c]);
          await this.afterLoseCards(p, [c], true);
          this.log(`${this.nameOf(p)} 对 ${this.nameOf(targets[0])} 发动【反间】，展示 ${this.cardText(c)}（选择：${D.SUITS[suit] ? D.SUITS[suit].name : '?'}）`, 'skill');
          this.emit();
          if (c.suit !== suit) await this.damage({ source: p, target: targets[0], amount: 1, reason: '反间' });
          return;
        }
        case 'lijian': {
          if (targets.length < 2) return;
          const duelTarget = targets[1];
          if (!targets[0].alive || !duelTarget || !duelTarget.alive) return;
          if (duelTarget.gender !== 'male' || targets[0].gender !== 'male') { this.log('【离间】只能选择两名男性角色', 'info'); return; }
          // 空城：没有手牌时不能成为【决斗】的目标
          if (duelTarget.skills.includes('kongcheng') && duelTarget.hand.length === 0) { this.log(`【离间】${this.nameOf(duelTarget)} 处于【空城】，不能成为【决斗】目标`, 'info'); return; }
          // 费用：一张手牌或装备区的牌
          let cost = (act.cards || []).map((id) => this.findCard(p, id)).filter(Boolean);
          if (!cost.length) {
            const pool = this.selectableCards(p);
            if (!pool.length) { this.log('【离间】没有可弃置的牌', 'info'); return; }
            const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: '【离间】：弃置一张牌（手牌或装备区）', cards: pool, min: 1, max: 1 });
            cost = (sel || []).map((x) => this.findCard(p, x.id)).filter(Boolean);
          }
          if (!cost.length) return;
          p.used.lijian = true;
          const spent = cost[0];
          this.removeAnyCard(p, spent.id);
          this.toDiscard([spent]);
          await this.afterLoseCards(p, [spent]);
          this.log(`${this.nameOf(p)} 发动【离间】：${this.nameOf(targets[0])} 与 ${this.nameOf(targets[1])} 决斗`, 'skill');
          await this.resolveDuel(targets[0], { id: -2, name: 'juedou', type: 'trick', suit: 'none', rank: 0, color: 'none', cards: [] }, targets[1]);
          return;
        }
        case 'jieyin': {
          if (cards.length < 2 || !targets[0]) return;
          p.used.jieyin = true;
          p.hand = p.hand.filter((c) => !cards.some((x) => x.id === c.id));
          this.toDiscard(cards);
          await this.afterLoseCards(p, cards);
          await this.recover(p, 1, p, '结姻');
          await this.recover(targets[0], 1, p, '结姻');
          this.log(`${this.nameOf(p)} 发动【结姻】`, 'skill');
          return;
        }
        case 'jijiang': {
          const allies = this.alivePlayers.filter((q) => q.seat !== p.seat && q.kingdom === '蜀');
          for (const a of allies) {
            const r = await this.askForNamedCard(a, 'sha', `主公 ${this.nameOf(p)} 发动【激将】，是否替其打出【杀】？`);
            if (r) {
              const c = { id: -3, name: 'sha', type: 'basic', nature: 'normal', suit: 'none', rank: 0, color: 'none', cards: [] };
              this.log(`${this.nameOf(a)} 响应【激将】打出【杀】`, 'skill');
              await this.resolveSlash(p, c, targets);
              return;
            }
          }
          this.log('无蜀势力角色响应【激将】', 'skill');
          return;
        }
        case 'qiangxi': {
          p.used.qiangxi = true;
          const hasWeapon = !!p.equips.weapon;
          const opt = await this.askOption(p, '【强袭】：失去 1 点体力，或弃置武器牌', hasWeapon ? ['hp', 'weapon'] : ['hp'], ['失去 1 点体力', '弃置武器']);
          if (opt === 'weapon' && hasWeapon) { const w = p.equips.weapon; p.equips.weapon = null; this.toDiscard([w]); await this.afterLoseCards(p, [w]); }
          else await this.loseHp(p, 1, '强袭');
          if (p.alive && targets[0] && targets[0].alive) await this.damage({ source: p, target: targets[0], amount: 1, reason: '强袭' });
          return;
        }
        case 'quhu': {
          p.used.quhu = true;
          const t = targets[0];
          if (!t) return;
          const win = await this.pindian(p, t, '驱虎');
          if (win) {
            const cands = this.alivePlayers.filter((q) => q.seat !== t.seat && this.inAttackRange(t, q)).map((q) => q.seat);
            if (cands.length) {
              const sel = await this.ask(p, { type: 'chooseTargets', player: p, reason: '驱虎：选择被伤害的角色', candidates: cands, min: 1, max: 1 });
              if (sel && sel[0] != null) await this.damage({ source: t, target: this.players[sel[0]], amount: 1, reason: '驱虎' });
            }
          } else await this.damage({ source: t, target: p, amount: 1, reason: '驱虎' });
          return;
        }
        case 'tianyi': {
          p.used.tianyi = true;
          const t = targets[0];
          if (!t) return;
          this.log(`${this.nameOf(p)} 发动【天义】`, 'skill');
          this.emit();
          const win = await this.pindian(p, t, '天义');
          if (win) { p.flags.tianyiWin = true; p.flags.extraSlash = (p.flags.extraSlash || 0) + 1; this.log(`${this.nameOf(p)} 赢下【天义】，本回合可额外使用一张【杀】且无距离限制`, 'skill'); }
          else { p.flags.tianyiLose = true; this.log(`${this.nameOf(p)} 未赢下【天义】，本回合不能使用【杀】`, 'skill'); }
          return;
        }
        case 'luanji': {
          if (cards.length < 2 || cards[0].suit !== cards[1].suit) return;
          p.hand = p.hand.filter((c) => !cards.some((x) => x.id === c.id));
          this.toDiscard(cards);
          await this.afterLoseCards(p, cards);
          const vc = { id: cards[0].id, name: 'wanjian', type: 'trick', suit: cards[0].suit, rank: cards[0].rank, color: cards[0].color, cards, skill: 'luanji' };
          this.log(`${this.nameOf(p)} 发动【乱击】`, 'skill');
          this.table.push(vc);
          await this.resolveAOE(p, vc, this.alivePlayers.filter((q) => q.seat !== p.seat), 'shan', 1);
          this.table = this.table.filter((c) => c !== vc);
          return;
        }
        case 'tiaoxin': {
          p.used.tiaoxin = true;
          const t = targets[0];
          if (!t) return;
          const r = await this.askForSha(t, { reason: `【挑衅】：对 ${this.nameOf(p)} 使用一张【杀】，否则其弃你一张牌`, mustUse: false, forcedTarget: p.seat, opponent: p.seat });
          if (r) {
            const vc = { id: -7, name: r.name || 'sha', type: 'basic', nature: r.nature || 'normal', suit: 'none', rank: 0, color: 'none', cards: [] };
            this.table.push(vc);
            await this.resolveSlash(t, vc, [p]);
            this.table = this.table.filter((c) => c !== vc);
          } else {
            const equipBefore = Object.values(t.equips).filter(Boolean);
            const handBefore = t.hand.length;
            const c = await this.pickCardFrom(t, p, { zones: ['hand', 'equip', 'judge'], reason: '挑衅：弃置其一张牌' });
            if (c) { this.toDiscard([c]); if (equipBefore.indexOf(c) < 0) await this.afterLoseCards(t, [c], t.hand.length === handBefore - 1); this.log(`${this.nameOf(p)} 弃置 ${this.nameOf(t)} 一张牌`, 'skill'); }
          }
          return;
        }
        case 'fangquan': { p.flags.fangquan = targets[0] ? targets[0].seat : -1; p.skip.play = true; this.log(`${this.nameOf(p)} 发动【放权】，跳过出牌阶段`, 'skill'); return; }
        case 'zhijian': {
          if (!cards.length || !targets[0]) return;
          const c = cards[0];
          const slot = c.subtype;
          if (!slot || c.type !== 'equip') { this.log('【直谏】只能置入装备牌', 'info'); return; }
          const prev = targets[0].equips[slot];
          p.hand = p.hand.filter((x) => x.id !== c.id);
          if (prev) {
            // 官方：目标装备栏已有牌时替换原装备
            targets[0].equips[slot] = null;
            this.toDiscard([prev]);
            this.afterLoseCards(targets[0], [prev]);
          }
          targets[0].equips[slot] = c;
          this.afterCardGain(targets[0], [c]);
          await this.afterLoseCards(p, [c]);
          this.drawCards(p, 1, '直谏');
          this.log(`${this.nameOf(p)} 对 ${this.nameOf(targets[0])} 发动【直谏】${prev ? '（替换原装备）' : ''}`, 'skill');
          return;
        }
        case 'luanwu': {
          p.once.luanwu = true;
          this.log(`${this.nameOf(p)} 发动【乱武】`, 'skill');
          for (const q of this.alivePlayers) {
            if (q.seat === p.seat || !q.alive) continue;
            // 空城：没有手牌的角色不能成为【杀】的目标，不能作为“最近角色”被指定
            const nearest = this.nearestPlayers(q).filter((x) => !(x.skills.includes('kongcheng') && x.hand.length === 0));
            if (!nearest.length) {
              this.log(`【乱武】：${this.nameOf(q)} 最近的角色均无法成为【杀】目标，失去 1 点体力`, 'skill');
              await this.loseHp(q, 1, '乱武');
              continue;
            }
            const ts = await this.ask(q, { type: 'chooseTargets', player: q, reason: '【乱武】：选择最近的一名角色作为【杀】的目标', candidates: nearest.map((x) => x.seat), min: 1, max: 1 });
            const tgt = (ts && nearest.find((x) => x.seat === ts[0])) || nearest[0];
            const r = await this.askForSha(q, { reason: `【乱武】：对 ${this.nameOf(tgt)} 使用一张【杀】，否则失去 1 点体力`, mustUse: false, forcedTarget: tgt.seat, opponent: tgt.seat });
            if (r) {
              const vc = { id: -8, name: r.name || 'sha', type: 'basic', nature: r.nature || 'normal', suit: 'none', rank: 0, color: 'none', cards: [] };
              this.table.push(vc);
              await this.resolveSlash(q, vc, [tgt]);
              this.table = this.table.filter((c) => c !== vc);
            } else await this.loseHp(q, 1, '乱武');
          }
          return;
        }
        case 'shensu': {
          p.flags.shensuUsed = true;
          p.skip.judge = true; p.skip.draw = true;
          const vc = { id: -4, name: 'sha', type: 'basic', nature: 'normal', suit: 'none', rank: 0, color: 'none', cards: [] };
          this.log(`${this.nameOf(p)} 发动【神速】，视为使用一张无距离限制的【杀】`, 'skill');
          await this.resolveSlash(p, vc, targets);
          return;
        }
        case 'jushou': { p.flags.jushou = true; this.drawCards(p, 3, '据守'); p.flipped = true; this.log(`${this.nameOf(p)} 发动【据守】摸三张并翻面`, 'skill'); return; }
        case 'dimeng': {
          if (targets.length < 2 || !targets[0] || !targets[1]) return;
          p.used.dimeng = true; // 已声明发动，避免 AI 反复尝试
          const diff = Math.abs(targets[0].hand.length - targets[1].hand.length);
          if (diff === 0) { this.log('两名角色手牌数相同，无需交换', 'info'); return; }
          if (this.selectableCards(p).length < diff) { this.log(`【缔盟】需要弃 ${diff} 张牌，牌不足无法发动`, 'info'); return; }
          const need = diff;
          const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: `缔盟：弃 ${need} 张牌`, cards: this.selectableCards(p), min: need, max: need });
          if (!sel || sel.length < need) return;
          for (const c of sel) { const moved = this.removeAnyCard(p, c.id); if (moved) this.toDiscard([moved]); await this.afterLoseCards(p, [moved]); }
          const h0 = targets[0].hand.slice(), h1 = targets[1].hand.slice();
          targets[0].hand = h1.slice(); targets[1].hand = h0.slice();
          // 交换后补失去/获得钩子
          for (const c of h1) this.afterCardGain(targets[0], [c]);
          for (const c of h0) this.afterCardGain(targets[1], [c]);
          if (h0.length) await this.afterLoseCards(targets[0], h0, true);
          if (h1.length) await this.afterLoseCards(targets[1], h1, true);
          this.log(`${this.nameOf(p)} 发动【缔盟】交换 ${this.nameOf(targets[0])} 与 ${this.nameOf(targets[1])} 的手牌`, 'skill');
          this.emit();
          return;
        }
        case 'huashen': {
          const opts = p.marks.huashen.options;
          const idx = await this.ask(p, {
            type: 'chooseOption', player: p, reason: '化身：选择要展示的化身牌',
            options: opts.map((o, i) => ({ id: String(i), label: o.general.name })),
          });
          if (idx != null && opts[Number(idx)]) await this.applyHuashen(p, Number(idx));
          return;
        }
        case 'zhiba': {
          p.used.zhiba = true;
          const lord = this.lord;
          if (!lord || !lord.alive) return;
          const win = await this.pindian(p, lord, '制霸');
          const pi = this._pindianCards || [];
          if (!win) {
            for (const c of pi) {
              this.discardPile = this.discardPile.filter((x) => x.id !== c.id);
              lord.hand.push(c);
              this.afterCardGain(lord, [c]);
            }
            this.log(`${this.nameOf(p)} 未赢下【制霸】，${this.nameOf(lord)} 获得两张拼点牌`, 'skill');
          } else this.log(`${this.nameOf(p)} 赢下【制霸】`, 'skill');
          return;
        }
        case 'jixi': {
          const t = targets[0];
          if (!t || !(p.marks.tian || 0)) return;
          p.marks.tian -= 1;
          const vc = { id: -9, name: 'shunshou', type: 'trick', suit: 'none', rank: 0, color: 'none', cards: [], skill: 'jixi' };
          this.log(`${this.nameOf(p)} 发动【急袭】`, 'skill');
          this.table.push(vc);
          await this.resolveDismantle(p, vc, t, true);
          this.table = this.table.filter((c) => c !== vc);
          return;
        }
        case 'shensu2': {
          const eqs = Object.values(p.equips).filter(Boolean).map((c) => ({ cardId: c.id, label: this.cardText(c) }));
          if (!eqs.length) return;
          const r = await this.ask(p, { type: 'response', player: p, need: 'discardEquip', options: eqs, reason: '神速②：弃置一张装备牌' });
          if (!r || r.cardId == null) return;
          const c = this.findCard(p, r.cardId);
          if (c) { this.removeAnyCard(p, c.id); this.toDiscard([c]); await this.afterLoseCards(p, [c]); }
          p.flags.shensu2Used = true;
          p.skip.play = true;
          const vc = { id: -10, name: 'sha', type: 'basic', nature: 'normal', suit: 'none', rank: 0, color: 'none', cards: [] };
          this.log(`${this.nameOf(p)} 发动【神速②】，视为使用一张无距离【杀】`, 'skill');
          await this.resolveSlash(p, vc, targets);
          return;
        }
        case 'guhuo': {
          if (!cards.length) return;
          const phys = cards[0];
          // 可声明：全部基本牌 + 全部普通锦囊（自动排除装备与延时锦囊）
          const names = Object.keys(CARDS).filter((n) => {
            const d = CARDS[n];
            return d && (d.type === 'basic' || d.type === 'trick');
          });
          const declared = await this.ask(p, {
            type: 'chooseOption', player: p, reason: '【蛊惑】：声明一张牌',
            options: names.map((n) => ({ id: n, label: CARDS[n].name })),
          });
          const dn = names.includes(declared) ? declared : 'sha';
          const ONE = ['sha', 'huosha', 'leisha', 'juedou', 'guohe', 'shunshou', 'huogong'];
          const AOE = ['nanman', 'wanjian'];
          const GLOBAL = ['taoyuan', 'wugu'];
          const SELF = ['wuzhong', 'tao', 'jiu'];
          const NOEFFECT = ['shan', 'wuxie'];
          let tgt = [];
          if (dn === 'jiedao') {
            const first = this.legalTargetsFor(p, 'jiedao', 'guhuo', [phys]);
            if (!first.length) { this.log('【蛊惑】没有可指定的持武器角色', 'info'); return; }
            const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: '蛊惑：选择持武器的角色', candidates: first, min: 1, max: 1 });
            const killer = this.players[(ts || [])[0]];
            if (!killer) return;
            const second = this.legalSecondTargetsFor(p, 'jiedao', killer.seat);
            if (!second.length) { this.log('【蛊惑】没有可被借刀杀人的目标', 'info'); return; }
            const ts2 = await this.ask(p, { type: 'chooseTargets', player: p, reason: '蛊惑：选择【杀】的目标', candidates: second, min: 1, max: 1 });
            const victim = this.players[(ts2 || [])[0]];
            if (!victim) return;
            tgt = [killer, victim];
          } else if (dn === 'tiesuo') {
            const cands = this.alivePlayers.map((q) => q.seat);
            const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: '蛊惑：选择至多两名角色横置/重置', candidates: cands, min: 1, max: 2 });
            tgt = (ts || []).map((s2) => this.players[s2]).filter(Boolean);
          } else if (ONE.includes(dn)) {
            const cands = this.legalTargetsFor(p, dn, 'guhuo', [phys]);
            if (!cands.length) { this.log(`【蛊惑】声明【${CARDS[dn].name}】没有合法目标`, 'info'); return; }
            const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: `蛊惑：为【${CARDS[dn].name}】选择目标`, candidates: cands, min: 1, max: 1 });
            tgt = (ts || []).map((s2) => this.players[s2]).filter(Boolean);
          } else if (AOE.includes(dn)) {
            tgt = this.alivePlayers.filter((q) => q.seat !== p.seat);
          } else if (GLOBAL.includes(dn)) {
            tgt = this.alivePlayers.slice();
          } else if (SELF.includes(dn)) {
            tgt = [p];
          }
          // 质疑
          const doubters = [];
          for (const q of this.alivePlayers) {
            if (q.seat === p.seat) continue;
            const r = await this.askOption(q, `【蛊惑】：${this.nameOf(p)} 声明【${CARDS[dn].name}】，是否质疑？`, ['yes', 'no'], ['质疑', '不质疑']);
            if (r === 'yes') doubters.push(q);
          }
          p.hand = p.hand.filter((c) => c.id !== phys.id);
          await this.afterLoseCards(p, [phys], true);
          this.log(`${this.nameOf(p)} 发动【蛊惑】，声明【${CARDS[dn].name}】${doubters.length ? '，质疑者：' + doubters.map((q) => this.nameOf(q)).join('、') : '，无人质疑'}`, 'skill');
          this.emit();
          let resolve = doubters.length === 0;
          if (doubters.length) {
            this.log(`展示：${this.cardText(phys)}`, 'info');
            const real = phys.name === dn;
            if (real) {
              for (const q of doubters) await this.loseHp(q, 1, '蛊惑');
              resolve = phys.suit === 'heart';
            } else {
              for (const q of doubters) this.drawCards(q, 1, '蛊惑');
              resolve = false;
            }
          }
          if (!resolve) { this.toDiscard([phys]); return; }
          // 【闪】【无懈可击】属于响应牌，出牌阶段声明后无结算对象
          if (NOEFFECT.includes(dn)) {
            this.log(`【${CARDS[dn].name}】只能在响应时使用，本次【蛊惑】不产生效果`, 'info');
            this.toDiscard([phys]);
            return;
          }
          const vc = { id: phys.id, name: dn, type: CARDS[dn].type, suit: phys.suit, rank: phys.rank, color: phys.color, cards: [phys], skill: 'guhuo', nature: CARDS[dn].nature || 'normal' };
          this.table.push(vc);
          await this.resolveVirtualCard(p, vc, tgt, {});
          this.table = this.table.filter((c) => c !== vc);
          // 巨象：蛊惑声明的【南蛮入侵】结算结束后由祝融获得
          const jxGain = dn === 'nanman' ? this.juxiangGain(p, [phys]) : false;
          if (!jxGain) this.toDiscard([phys]);
          return;
        }
        case 'zhangba': {
          if (cards.length < 2) return;
          p.hand = p.hand.filter((c) => !cards.some((x) => x.id === c.id));
          await this.afterLoseCards(p, cards, true);
          const vc = { id: cards[0].id, name: 'sha', type: 'basic', nature: 'normal', suit: cards[0].suit, rank: cards[0].rank, color: cards[0].color, cards: cards.slice(), skill: 'zhangba' };
          this.table.push(vc);
          await this.resolveSlash(p, vc, targets);
          this.table = this.table.filter((c) => c !== vc);
          this.toDiscard(cards);
          this.log(`${this.nameOf(p)} 发动【丈八蛇矛】将两张手牌当【杀】`, 'skill');
          return;
        }
        case 'huangtian': {
          const lord = this.lord;
          if (!lord || !lord.alive || lord.seat === p.seat) return;
          const give = cards[0];
          if (!give || (give.name !== 'shan' && give.name !== 'shandian')) { this.log('【黄天】只能将【闪】或【闪电】交给张角', 'info'); return; }
          p.used.huangtian = true;
          p.hand = p.hand.filter((c) => c.id !== give.id);
          lord.hand.push(give);
          this.afterCardGain(lord, [give]);
          this.log(`${this.nameOf(p)} 发动【黄天】交给主公 ${this.cardText(give)}`, 'skill');
          return;
        }
        case 'qiaobian': {
          if (!cards.length) return;
          const cost = cards[0];
          const opt = await this.askOption(p, '【巧变】：弃置一张手牌并选择跳过的阶段', ['play', 'discard', 'no'], ['跳过出牌阶段（并移动场上一张牌）', '跳过弃牌阶段', '不发动']);
          if (opt === 'no') return;
          p.used.qiaobian = true;
          p.hand = p.hand.filter((c) => c.id !== cost.id);
          this.toDiscard([cost]);
          await this.afterLoseCards(p, [cost]);
          if (opt === 'discard') {
            p.skip.discard = true;
            this.log(`${this.nameOf(p)} 发动【巧变】跳过弃牌阶段`, 'skill');
            return;
          }
          p.skip.play = true;
          this.log(`${this.nameOf(p)} 发动【巧变】跳过出牌阶段`, 'skill');
          await this.qiaobianMove(p);
          return;
        }
        default: {
          this.log(`技能【${SKILLS[S] ? SKILLS[S].name : S}】暂未实现完整结算`, 'info');
          return;
        }
      }
    },

    async pindian(p, t, reason) {
      if (!p.hand.length || !t.hand.length) return false;
      const a = await this.ask(p, { type: 'chooseCards', player: p, reason: `【${reason}】拼点：选择一张手牌`, cards: p.hand.slice(), min: 1, max: 1 });
      const b = await this.ask(t, { type: 'chooseCards', player: t, reason: `【${reason}】拼点：选择一张手牌`, cards: t.hand.slice(), min: 1, max: 1 });
      if (!a || !a.length || !b || !b.length) return false;
      const ca = p.hand.find((c) => c.id === a[0].id), cb = t.hand.find((c) => c.id === b[0].id);
      if (!ca || !cb) return false;
      p.hand = p.hand.filter((c) => c !== ca); t.hand = t.hand.filter((c) => c !== cb);
      this._pindianCards = [ca, cb];
      this.toDiscard([ca, cb]);
      const win = ca.rank > cb.rank;
      const tie = ca.rank === cb.rank;
      this.log(`【${reason}】拼点：${this.nameOf(p)} ${this.cardText(ca)} vs ${this.nameOf(t)} ${this.cardText(cb)} → ${tie ? '平局' : win ? this.nameOf(p) + ' 赢' : this.nameOf(t) + ' 赢'}`, 'pindian');
      const cardInfo = (c) => ({ name: c.name, suit: c.suit, rank: c.rank, color: c.color });
      this.recent.push({
        kind: 'pindian', reason: reason,
        a: { seat: p.seat, name: this.nameOf(p), card: cardInfo(ca) },
        b: { seat: t.seat, name: this.nameOf(t), card: cardInfo(cb) },
        win: win, tie: tie,
      });
      if (this.recent.length > 200) this.recent.shift();
      this.emit();
      await this.pause(1700);
      return win;
    },

    nearestPlayers(p) {
      const others = this.alivePlayers.filter((q) => q.seat !== p.seat);
      if (!others.length) return [];
      const min = Math.min(...others.map((q) => this.distance(p, q)));
      return others.filter((q) => this.distance(p, q) === min);
    },

    async skillTrigger(event, p, data) {
      // 只有【死亡时】允许已阵亡角色触发；其余事件不再向死者派发技能
      if (!p || (event !== 'onDeath' && !p.alive)) return null;
      switch (event) {
        case 'phaseStart': return this.skillPhaseStart(p);
        case 'drawPhase': return this.skillDrawPhase(p);
        case 'endPhase': return this.skillEndPhase(p);
        case 'afterDamage': return this.skillAfterDamage(p, data);
        case 'onDeath': return this.skillOnDeath(p, data);
        default: return null;
      }
    },

    // ================= 阶段开始钩子：神速 / 巧变 =================
    // 神速①：判定阶段开始时；神速②：摸牌阶段开始时；
    // 巧变：判定/摸牌/出牌/弃牌阶段开始时（每回合一次）。
    async skillPhaseHook(p, phase) {
      // 泰然（司马师）：出牌阶段开始时，失去以此法回复的体力并弃置以此法获得的手牌
      if (phase === 'play' && has(p, 'j_tairan') && p.flags && p.flags.tairan) {
        const tr = p.flags.tairan;
        delete p.flags.tairan;
        if (tr.hp > 0) await this.loseHp(p, tr.hp, '泰然');
        const cards = (tr.ids || []).map((id) => this.findCard(p, id)).filter(Boolean);
        if (cards.length) {
          p.hand = p.hand.filter((c) => cards.indexOf(c) < 0);
          this.toDiscard(cards);
          await this.afterLoseCards(p, cards);
        }
        this.log(`${this.nameOf(p)} 发动【泰然】，失去 ${tr.hp} 点体力并弃置 ${cards.length} 张牌`, 'skill');
        this.emit();
      }
      // 神速①：跳过判定+摸牌，视为使用无距离【杀】
      if (phase === 'judge' && has(p, 'shensu') && !p.flags.shensuUsed) {
        const cands = this.legalTargetsFor(p, 'sha', null);
        if (cands.length) {
          const r = await this.askOption(p, '【神速①】：是否跳过判定阶段和摸牌阶段，视为使用一张无距离限制的【杀】？', ['yes', 'no'], ['发动', '不发动']);
          if (r === 'yes') {
            p.flags.shensuUsed = true;
            p.skip.judge = true; p.skip.draw = true;
            const sel = await this.ask(p, { type: 'chooseTargets', player: p, reason: '神速：选择【杀】的目标', candidates: cands, min: 1, max: 1 });
            const t = sel && this.players[sel[0]];
            if (t) await this.resolveSlash(p, { id: -5, name: 'sha', type: 'basic', nature: 'normal', suit: 'none', rank: 0, color: 'none', cards: [] }, [t]);
            this.log(`${this.nameOf(p)} 发动【神速①】，跳过判定与摸牌阶段`, 'skill');
            this.emit();
            return;
          }
        }
      }
      // 神速②：摸牌阶段开始时，弃一张装备，视为使用无距离【杀】并跳过出牌阶段
      if (phase === 'draw' && has(p, 'shensu') && !p.flags.shensu2Used && Object.values(p.equips).some(Boolean)) {
        const cands = this.legalTargetsFor(p, 'sha', null);
        if (cands.length) {
          const r = await this.askOption(p, '【神速②】：是否弃置一张装备牌，视为使用一张无距离限制的【杀】并跳过出牌阶段？', ['yes', 'no'], ['发动', '不发动']);
          if (r === 'yes') {
            const eqs = Object.values(p.equips).filter(Boolean).map((c) => ({ cardId: c.id, label: this.cardText(c) }));
            const er = await this.ask(p, { type: 'response', player: p, need: 'discardEquip', options: eqs, reason: '神速②：弃置一张装备牌' });
            const ec = er && er.cardId != null ? this.findCard(p, er.cardId) : null;
            if (ec) {
              this.removeAnyCard(p, ec.id);
              this.toDiscard([ec]);
              await this.afterLoseCards(p, [ec]);
              p.flags.shensu2Used = true;
              p.skip.play = true;
              const sel = await this.ask(p, { type: 'chooseTargets', player: p, reason: '神速②：选择【杀】的目标', candidates: cands, min: 1, max: 1 });
              const t = sel && this.players[sel[0]];
              if (t) await this.resolveSlash(p, { id: -10, name: 'sha', type: 'basic', nature: 'normal', suit: 'none', rank: 0, color: 'none', cards: [] }, [t]);
              this.log(`${this.nameOf(p)} 发动【神速②】，弃置 ${this.cardText(ec)}，跳过出牌阶段`, 'skill');
              this.emit();
            }
          }
        }
      }
      // 巧变：阶段开始时弃一张手牌跳过该阶段（每回合一次）
      const QIAO = { judge: '判定', draw: '摸牌', play: '出牌', discard: '弃牌' };
      if (QIAO[phase] && has(p, 'qiaobian') && p.hand.length && !p.flags.qiaobian) {
        const r = await this.askOption(p, `【巧变】：是否弃置一张手牌，跳过${QIAO[phase]}阶段？`, ['yes', 'no'], ['发动', '不发动']);
        if (r === 'yes') {
          const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: '巧变：弃置一张手牌', cards: p.hand.slice(), min: 1, max: 1 });
          const c = sel && sel.length ? this.findCard(p, sel[0].id) : null;
          if (c) {
            p.flags.qiaobian = true;
            p.hand = p.hand.filter((x) => x.id !== c.id);
            this.toDiscard([c]);
            await this.afterLoseCards(p, [c]);
            p.skip[phase] = true;
            this.log(`${this.nameOf(p)} 发动【巧变】弃置 ${this.cardText(c)}，跳过${QIAO[phase]}阶段`, 'skill');
            if (phase === 'draw') {
              const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && q.hand.length).map((q) => q.seat);
              if (cands.length) {
                const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: '巧变：选择至多两名角色各获得一张手牌', candidates: cands, min: 1, max: 2 });
                for (const s2 of (ts || []).slice(0, 2)) {
                  const q = this.players[s2];
                  if (q && q.hand.length) {
                    const got = q.hand[this.rand(q.hand.length)];
                    q.hand = q.hand.filter((x) => x !== got);
                    p.hand.push(got);
                    this.afterCardGain(p, [got]);
                  }
                }
              }
            } else if (phase === 'play') {
              await this.qiaobianMove(p);
            }
            this.emit();
          }
        }
      }
    },

    async skillPhaseStart(p) {
      // 化身优先结算：回合开始时先确定/替换展示的化身牌及技能，
      // 这样本阶段后续的觉醒技等检查能看到化身获得的技能。
      if (has(p, 'huashen')) {
        this.initHuashen(p);
        await this.ensureHuashenSkill(p);
        await this.tryHuashenSwap(p, 'huashen');
      }
      if (has(p, 'yinghun') && p.hp < p.maxHp) {
        const lost = p.maxHp - p.hp;
        const r = await this.askOption(p, `【英魂】：已损失 ${lost} 点体力，是否发动？`, ['yes', 'no'], ['发动', '不发动']);
        if (r === 'yes') {
          const sel = await this.ask(p, { type: 'chooseTargets', player: p, reason: '英魂：选择一名其他角色', candidates: this.alivePlayers.filter((q) => q.seat !== p.seat).map((q) => q.seat), min: 1, max: 1 });
          const t = sel && this.players[sel[0]];
          if (t) {
            // 由孙坚选择模式，由目标决定弃置哪些牌
            const mode = await this.askOption(p, `【英魂】：令 ${this.nameOf(t)} 摸 ${lost} 张后弃 1 张，还是摸 1 张后弃 ${lost} 张？`, ['draw', 'discard'], ['摸牌后弃 1 张', '摸 1 张后弃牌']);
            this.log(`${this.nameOf(p)} 发动【英魂】（${mode === 'draw' ? `摸${lost}弃1` : `摸1弃${lost}`}）`, 'skill');
            if (mode === 'draw') {
              this.drawCards(t, lost, '英魂');
              if (t.hand.length) {
                const ds = await this.ask(t, { type: 'chooseCards', player: t, reason: '英魂：弃置一张手牌', cards: t.hand.slice(), min: 1, max: 1 });
                const dc = (ds || []).map((x) => this.findCard(t, x.id)).filter(Boolean)[0];
                if (dc) { t.hand = t.hand.filter((x) => x.id !== dc.id); this.toDiscard([dc]); await this.afterLoseCards(t, [dc]); }
              }
            } else {
              this.drawCards(t, 1, '英魂');
              const n = Math.min(lost, t.hand.length);
              if (n > 0) {
                const ds = await this.ask(t, { type: 'chooseCards', player: t, reason: `英魂：弃置 ${n} 张手牌`, cards: t.hand.slice(), min: n, max: n });
                const picked = (ds || []).slice(0, n).map((x) => this.findCard(t, x.id)).filter(Boolean);
                for (const dc of picked) { t.hand = t.hand.filter((x) => x.id !== dc.id); this.toDiscard([dc]); }
                if (picked.length) await this.afterLoseCards(t, picked);
              }
            }
            this.emit();
          }
        }
      }
      if (has(p, 'zaoxian') && !p.once.zaoxian && (p.marks.tian || 0) >= 3) { p.once.zaoxian = true; p.maxHp -= 1; p.skills.push('jixi'); this.log(`${this.nameOf(p)} 觉醒【凿险】，获得【急袭】`, 'skill'); this.emit(); }
      if (has(p, 'zhiji') && !p.once.zhiji && p.hand.length === 0) {
        p.once.zhiji = true; p.maxHp -= 1;
        const ch = await this.askOption(p, '【志继】：回复 1 点体力，或摸两张牌？', ['heal', 'draw'], ['回复 1 点体力', '摸两张牌']);
        if (ch === 'heal') await this.recover(p, 1, p, '志继'); else this.drawCards(p, 2, '志继');
        p.skills.push('guanxing');
        this.log(`${this.nameOf(p)} 觉醒【志继】，获得【观星】`, 'skill'); this.emit();
      }
      if (has(p, 'ruoyu') && !p.once.ruoyu && p.role === 'lord') {
        const minHp = Math.min(...this.alivePlayers.map((q) => q.hp));
        if (p.hp === minHp) { p.once.ruoyu = true; p.maxHp += 1; await this.recover(p, 1, p, '若愚'); if (!p.skills.includes('jijiang')) p.skills.push('jijiang'); this.log(`${this.nameOf(p)} 觉醒【若愚】，获得【激将】`, 'skill'); this.emit(); }
      }
      if (has(p, 'hunzi') && !p.once.hunzi && p.hp === 1) { p.once.hunzi = true; p.maxHp -= 1; p.skills.push('yingzi', 'yinghun'); this.log(`${this.nameOf(p)} 觉醒【魂姿】，获得【英姿】和【英魂】`, 'skill'); this.emit(); }
      // 观星（诸葛亮 Po）：准备阶段观看 5 张（存活<4 时 3 张），可全部置底后在结束阶段再发动
      if (has(p, 'j_guanxing')) await this.skillGuanxingJ(p);
      // 替身（张飞 Po，限定技）：回复所有体力并摸等量牌
      if (has(p, 'j_tishen') && !p.once.tishen && p.hp < p.maxHp) {
        const r = await this.askOption(p, '【替身（限定技）】：是否回复所有体力，然后摸X张牌（X为回复的体力值）？', ['yes', 'no'], ['发动', '不发动']);
        if (r === 'yes') {
          p.once.tishen = true;
          const real = await this.recover(p, p.maxHp - p.hp, p, '替身');
          if (real > 0) this.drawCards(p, real, '替身');
          this.log(`${this.nameOf(p)} 发动【替身】，回复 ${real} 点体力并摸 ${real} 张牌`, 'skill');
          this.emit();
        }
      }
      // 勤学（吕蒙 Po，觉醒技）：准备阶段手牌数比体力值多 2 或更多
      if (has(p, 'j_qinxue') && !p.once.j_qinxue && p.hand.length >= p.hp + 2) await this.awakenQinxue(p);
    },

    async skillDrawPhase(p) {
      if (has(p, 'haoshi')) {
        const r = await this.askOption(p, '【好施】：是否额外摸两张牌？若手牌超过 5 张，需将一半交给手牌最少的角色', ['yes', 'no'], ['发动', '正常摸牌']);
        if (r === 'yes') {
          this.drawCards(p, 4, '好施');
          if (p.hand.length > 5) {
            const half = Math.floor(p.hand.length / 2);
            const others = this.alivePlayers.filter((q) => q.seat !== p.seat);
            if (others.length) {
              others.sort((a, b) => a.hand.length - b.hand.length);
              const t = others[0];
              const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: `好施：交给 ${this.nameOf(t)} ${half} 张牌`, cards: p.hand.slice(), min: half, max: half });
              if (sel) {
                const ids = sel.map((x) => (x && typeof x === 'object') ? x.id : x);
                const moved = p.hand.filter((c) => ids.includes(c.id));
                p.hand = p.hand.filter((c) => !ids.includes(c.id));
                t.hand.push(...moved);
                for (const c of moved) this.afterCardGain(t, [c]);
                await this.afterLoseCards(p, moved, true);
                this.log(`${this.nameOf(p)} 将 ${moved.length} 张牌交给 ${this.nameOf(t)}`, 'skill');
              }
            }
          }
          this.emit();
          return true;
        }
      }
      if (has(p, 'shuangxiong') && !p.flags.shuangxiong) {
        const r = await this.askOption(p, '【双雄】：是否改为进行判定并获得判定牌？', ['yes', 'no'], ['发动', '正常摸牌']);
        if (r === 'yes') {
          p.flags.shuangxiong = true;
          const j = await this.judge(p, '双雄');
          p.hand.push(j.card); this.afterCardGain(p, [j.card]);
          p.flags.shuangxiongColor = j.card.color;
          this.log(`${this.nameOf(p)} 发动【双雄】，本回合可将${j.card.color === 'red' ? '黑' : '红'}色手牌当【决斗】`, 'skill');
          this.emit();
          return true;
        }
      }
      if (has(p, 'zaiqi') && p.hp < p.maxHp) {
        const r = await this.askOption(p, '【再起】：是否亮出牌堆顶 X 张牌（X 为已损失体力）？', ['yes', 'no'], ['发动', '正常摸牌']);
        if (r === 'yes') {
          const x = p.maxHp - p.hp;
          let heal = 0;
          for (let i = 0; i < x; i++) {
            if (this.deck.length === 0) this.reshuffle();
            const c = this.deck.pop(); if (!c) break;
            if (c.suit === 'heart') { heal++; this.toDiscard([c]); }
            else { p.hand.push(c); this.afterCardGain(p, [c]); }
          }
          if (heal) await this.recover(p, heal, p, '再起');
          this.log(`${this.nameOf(p)} 发动【再起】`, 'skill');
          this.emit();
          return true;
        }
      }
      return false;
    },

    async skillEndPhase(p) {
      // 袭爵（张虎乐綝）：结束阶段获得本回合造成伤害数的“爵”
      if (has(p, 'j_xijue')) {
        const x = p.flags.damageCount || 0;
        p.marks = p.marks || {};
        p.marks.jue = (p.marks.jue || 0) + x;
        this.log(`${this.nameOf(p)} 发动【袭爵】获得 ${x} 枚“爵”（当前 ${p.marks.jue}）`, 'skill');
        this.emit();
      }
      // 袭爵（其他角色结束阶段）：移除 1 枚“爵”发动【骁果】
      for (const q of this.alivePlayers.slice()) {
        if (q.seat === p.seat || !q.skills.includes('j_xijue') || (q.marks.jue || 0) <= 0) continue;
        const basics = q.hand.filter((c) => c.type === 'basic');
        if (!basics.length) continue;
        const r = await this.askOption(q, `【袭爵】：是否移除 1 枚“爵”（剩余 ${q.marks.jue}）发动【骁果】？`, ['yes', 'no'], ['发动', '不发动']);
        if (r !== 'yes') continue;
        const sel = await this.ask(q, { type: 'chooseCards', player: q, reason: '骁果：弃置一张基本牌', cards: basics, min: 1, max: 1 });
        const c = sel && sel.length ? this.findCard(q, sel[0].id) : null;
        if (!c) continue;
        q.marks.jue -= 1;
        q.hand = q.hand.filter((x) => x.id !== c.id);
        this.toDiscard([c]);
        await this.afterLoseCards(q, [c]);
        this.log(`${this.nameOf(q)} 发动【骁果】弃置 ${this.cardText(c)}`, 'skill');
        const eqs = Object.keys(p.equips).filter((k) => p.equips[k]);
        const opts = eqs.length ? [{ id: 'equip', label: '弃置一张装备牌，其摸一张' }, { id: 'damage', label: '受到 1 点伤害' }] : [{ id: 'damage', label: '受到 1 点伤害' }];
        const ch = await this.ask(p, { type: 'chooseOption', player: p, reason: '骁果：请选择', options: opts });
        if (ch === 'equip' && eqs.length) {
          const slot = eqs.length === 1 ? eqs[0] : await this.askOption(p, '骁果：弃置一张装备牌', eqs, eqs.map((k) => this.cardText(p.equips[k])));
          const card = p.equips[slot];
          if (card) { p.equips[slot] = null; this.toDiscard([card]); await this.afterLoseCards(p, [card]); this.drawCards(q, 1, '骁果'); }
        } else {
          await this.damage({ source: q, target: p, amount: 1, reason: '骁果' });
        }
      }
      // 诛害（徐庶）：其他角色的结束阶段，若其本回合造成过伤害，可对其使用一张【杀】
      if (p.alive && p.flags && p.flags.dealtDamage) {
        for (const q of this.alivePlayers.slice()) {
          if (q.seat === p.seat || !q.skills.includes('zhuhai') || !q.alive || !p.alive) continue;
          const shas = q.hand.filter((c) => ['sha', 'huosha', 'leisha'].includes(c.name));
          if (!shas.length) continue;
          const legal = this.legalTargetsFor(q, 'sha', null);
          if (!legal.includes(p.seat)) continue;
          const r = await this.askOption(q, `【诛害】：${this.nameOf(p)} 本回合造成过伤害，是否对其使用一张【杀】？`, ['yes', 'no'], ['发动', '放弃']);
          if (r !== 'yes') continue;
          let card = shas[0];
          if (shas.length > 1) {
            const sel = await this.ask(q, { type: 'chooseCards', player: q, reason: '诛害：选择一张【杀】', cards: shas, min: 1, max: 1 });
            if (sel && sel.length) card = this.findCard(q, sel[0].id) || card;
          }
          this.log(`${this.nameOf(q)} 发动【诛害】对 ${this.nameOf(p)} 使用【杀】`, 'skill');
          await this.useVirtualCard(q, [card], card.name, null, [p]);
        }
      }
      if (has(p, 'bengqiang')) {
        const alive = this.alivePlayers;
        const minHp = Math.min(...alive.map((q) => q.hp));
        if (p.hp > minHp) {
          const r = await this.askOption(p, '【崩坏】：是否减少 1 点体力上限？', ['yes', 'no'], ['减体力上限', '失去体力']);
          // 官方为随机选择；此处默认减体力上限
          if (r === 'yes') { p.maxHp = Math.max(1, p.maxHp - 1); this.log(`${this.nameOf(p)} 发动【崩坏】，体力上限 -1`, 'skill'); }
          else await this.loseHp(p, 1, '崩坏');
        }
      }
      if (has(p, 'jushou') && !p.flags.jushou) {
        const r = await this.askOption(p, '【据守】：是否摸三张牌并翻面？', ['yes', 'no'], ['发动', '不发动']);
        if (r === 'yes') {
          p.flags.jushou = true;
          this.drawCards(p, 3, '据守');
          p.flipped = true;
          this.log(`${this.nameOf(p)} 发动【据守】`, 'skill');
        }
      }
      // 勤学（吕蒙 Po，觉醒技）：结束阶段手牌数比体力值多 2 或更多
      if (has(p, 'j_qinxue') && !p.once.j_qinxue && p.hand.length >= p.hp + 2) await this.awakenQinxue(p);
      // 观星（诸葛亮 Po）：若准备阶段全部置于牌堆底，结束阶段可再次发动（本回合仅一次）
      if (has(p, 'j_guanxing') && p.flags && p.flags.guanxingAllBottom && !p.flags.guanxingEndUsed) {
        const r = await this.askOption(p, '【观星】：准备阶段已将牌全部置于牌堆底，是否再次发动？', ['yes', 'no'], ['发动', '不发动']);
        if (r === 'yes') {
          p.flags.guanxingEndUsed = true;
          p.flags.guanxingAllBottom = false;
          await this.skillGuanxingJ(p);
        }
      }
      // 化身：结束阶段也可以替换展示的化身牌及技能（与回合开始各限一次）
      await this.tryHuashenSwap(p, 'huashenEnd');
      return false;
    },

    async skillAfterDamage(p, data) {
      const { source, amount, card, nature } = data || {};
      if (!p.alive) return;
      // 耀武（华雄 Po，锁定技）：受到伤害时，造成伤害的牌为红色→来源摸一张；否则→华雄摸一张
      if (has(p, 'j_yaowu') && card) {
        const red = card.color === 'red' || ['heart', 'diamond'].includes(card.suit);
        if (red) {
          if (source && source.alive) this.drawCards(source, 1, '耀武');
          this.log(`【耀武】：${source ? this.nameOf(source) : '伤害来源'} 摸一张牌`, 'skill');
        } else {
          this.drawCards(p, 1, '耀武');
          this.log(`${this.nameOf(p)} 发动【耀武】摸一张牌`, 'skill');
        }
        this.emit();
      }
      if (has(p, 'jieming')) {
        const points = Math.max(1, Number(amount) || 1);
        for (let i = 0; i < points && p.alive; i++) {
          const r = await this.askOption(p, '【节命】：是否令一名角色将手牌补至体力上限？', ['yes', 'no'], ['发动', '放弃']);
          if (r !== 'yes') break;
          const sel = await this.ask(p, { type: 'chooseTargets', player: p, reason: '节命：选择一名角色', candidates: this.alivePlayers.map((q) => q.seat), min: 1, max: 1 });
          const t = sel && this.players[sel[0]];
          if (t) { const n = Math.max(0, Math.min(t.maxHp, 5) - t.hand.length); if (n > 0) this.drawCards(t, n, '节命'); }
        }
      }
      if (has(p, 'fangzhu')) {
        const r = await this.askOption(p, '【放逐】：是否令一名角色摸 X 张牌并翻面？', ['yes', 'no'], ['发动', '放弃']);
        if (r === 'yes') {
          const cands = this.alivePlayers.filter((q) => q.seat !== p.seat).map((q) => q.seat);
          const sel = await this.ask(p, { type: 'chooseTargets', player: p, reason: '放逐：选择一名其他角色', candidates: cands, min: 1, max: 1 });
          const t = sel && this.players[sel[0]];
          if (t) { this.drawCards(t, Math.max(1, p.maxHp - p.hp), '放逐'); t.flipped = true; this.log(`${this.nameOf(t)} 被【放逐】摸牌并翻面`, 'skill'); }
        }
      }
      if (has(p, 'xinsheng') && p.marks.huashen) {
        const h = p.marks.huashen;
        if (h.options.length < 4) {
          const used = new Set(h.options.map((o) => o.general.id));
          const pool = this.availableGenerals().filter((g) => !used.has(g.id) && g.id !== p.general.id);
          if (pool.length) {
            const g = pool[this.rand(pool.length)];
            h.options.push({ general: g, skill: null }); // 具体技能在展示时选择
            this.log(`${this.nameOf(p)} 发动【新生】，获得新的化身：${g.name}`, 'skill');
            this.emit();
          }
        }
      }
      if (has(p, 'tuntian')) { /* 失去牌时判定 */ }
    },

    async skillXingshang(q, dead) {
      const cards = [...dead.hand, ...Object.values(dead.equips).filter(Boolean), ...dead.judges];
      if (!cards.length) return;
      const r = await this.askOption(q, `【行殇】：是否获得阵亡的 ${this.nameOf(dead)} 的所有牌？`, ['yes', 'no'], ['获得', '放弃']);
      if (r !== 'yes') return;
      dead.hand = []; dead.judges = [];
      for (const k of Object.keys(dead.equips)) dead.equips[k] = null;
      for (const c of cards) { q.hand.push(c); this.afterCardGain(q, [c]); }
      this.log(`${this.nameOf(q)} 发动【行殇】获得 ${cards.length} 张牌`, 'skill');
      this.emit();
    },

    async skillOnDeath(p, data) {
      const killer = data && data.killer;
      if (has(p, 'duanchang') && killer && killer.seat !== p.seat) {
        killer.skills = [];
        this.log(`${this.nameOf(killer)} 因【断肠】失去所有技能`, 'skill');
      }
    },

    // ================= 失去牌后的触发（屯田） =================
    // 获得牌后的异步钩子：清俭（夏侯惇 Po）
    async afterCardGainHook(p, cards) {
      if (!p || !p.alive || !p.skills || !p.skills.includes('j_qingjian')) return;
      if (p._qingjianBusy) return;
      p._qingjianBusy = true;
      try {
        await this._afterCardGainHookInner(p, cards);
      } finally {
        p._qingjianBusy = false;
      }
    },

    async _afterCardGainHookInner(p, cards) {
      if (this.phase === 'draw' && this.currentSeat === p.seat) return; // 摸牌阶段外
      p.flags = p.flags || {};
      if (p.flags.qingjianTurn === this.turnCount) return;
      const pool = (cards || []).filter((c) => c && p.hand.some((x) => x.id === c.id));
      if (!pool.length) return;
      const r = await this.askOption(p, '【清俭】：是否展示并交给一名其他角色任意张牌，令当前回合角色本回合手牌上限 +X？', ['yes', 'no'], ['发动', '放弃']);
      if (r !== 'yes') return;
      p.flags.qingjianTurn = this.turnCount;
      const others = this.alivePlayers.filter((q) => q.seat !== p.seat).map((q) => q.seat);
      if (!others.length) return;
      const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: '清俭：选择交给其他角色的牌', cards: pool, min: 1, max: pool.length });
      const chosen = (sel || []).slice(0, pool.length).map((x) => this.findCard(p, x.id)).filter(Boolean);
      if (!chosen.length) return;
      const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: '清俭：选择交给的角色', candidates: others, min: 1, max: 1 });
      const t = ts && this.players[ts[0]];
      if (!t || !t.alive) return;
      const types = new Set(chosen.map((c) => { const d = CARDS[c.name] || {}; return d.type === 'delayed' ? 'trick' : d.type; }));
      const x = types.size;
      for (const c of chosen) {
        p.hand = p.hand.filter((y) => y.id !== c.id);
        t.hand.push(c);
        this.afterCardGain(t, [c]);
      }
      await this.afterLoseCards(p, chosen, true);
      const cur = this.players[this.currentSeat];
      if (cur && cur.alive) { cur.flags = cur.flags || {}; cur.flags.qingjianLimit = (cur.flags.qingjianLimit || 0) + x; }
      this.log(`${this.nameOf(p)} 发动【清俭】交给 ${this.nameOf(t)} ${chosen.length} 张牌，当前回合角色手牌上限 +${x}`, 'skill');
      this.emit();
    },

    async afterLoseCardsHook(p, cards, fromHand) {
      if (!p.alive || !cards.length) return;
      if (has(p, 'tuntian') && !this._inTuntian && this.currentSeat !== p.seat) {
        const lost = cards.filter((c) => c && c.type !== 'delay');
        if (!lost.length) return;
        const j = await this.judge(p, '屯田');
        if (j.card.suit !== 'heart') {
          p.marks.tian = (p.marks.tian || 0) + 1;
          this.log(`${this.nameOf(p)} 发动【屯田】获得 1 枚「田」（${p.marks.tian}）`, 'skill');
        }
      }
      // 连营（陆逊 Po）：失去所有手牌后，令至多 X 名角色各摸一张（X=失去的手牌数）
      if (has(p, 'j_lianying') && p.hand.length === 0 && (fromHand || cards.some((c) => c.type !== 'equip')) && !this._inLianying) {
        const x = Math.max(1, cards.filter((c) => c && c.type !== 'equip').length);
        this._inLianying = true;
        try {
          const r = await this.askOption(p, `【连营】：是否令至多 ${x} 名角色各摸一张牌？`, ['yes', 'no'], ['发动', '放弃']);
          if (r === 'yes') {
            const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: `连营：选择至多 ${x} 名角色`, candidates: this.alivePlayers.map((q) => q.seat), min: 1, max: x });
            const seats = (ts || []).slice(0, x);
            for (const seat of seats) { const q = this.players[seat]; if (q && q.alive) this.drawCards(q, 1, '连营'); }
            this.log(`${this.nameOf(p)} 发动【连营】令 ${seats.length} 名角色各摸一张牌`, 'skill');
          }
        } finally {
          this._inLianying = false;
        }
      }
    },

    async skillLeiji(p) {
      const targets = this.alivePlayers.filter((q) => q.seat !== p.seat);
      if (!targets.length) return;
      const r = await this.askOption(p, '【雷击】：是否发动？令一名角色判定，若为黑桃则受到 2 点雷电伤害', ['yes', 'no'], ['发动', '放弃']);
      if (r !== 'yes') return;
      const sel = await this.ask(p, { type: 'chooseTargets', player: p, reason: '雷击：选择目标', candidates: targets.map((q) => q.seat), min: 1, max: 1 });
      const t = sel && this.players[sel[0]];
      if (!t) return;
      const j = await this.judge(p, '雷击');
      if (j.card.suit === 'spade') {
        this.log(`【雷击】判定为黑桃，${this.nameOf(t)} 受到 2 点雷电伤害`, 'skill');
        await this.damage({ source: p, target: t, amount: 2, nature: 'thunder', reason: '雷击' });
      }
    },

    // 巧变：将一名角色装备区/判定区的一张牌移动到另一名角色的对应区域
    async qiaobianMove(mover) {
      const srcCands = this.alivePlayers.filter((q) => Object.values(q.equips).some(Boolean) || q.judges.length);
      if (!srcCands.length) { this.log('【巧变】：场上没有可移动的牌', 'info'); return; }
      const sel = await this.ask(mover, { type: 'chooseTargets', player: mover, reason: '巧变：选择要移动其场上牌的角色', candidates: srcCands.map((q) => q.seat), min: 1, max: 1 });
      const from = sel && this.players[sel[0]];
      if (!from || !from.alive) { this.log('【巧变】：未选择来源角色', 'info'); return; }
      // 先确定目标区域，避免牌被移出后无处安放
      const destCands = this.alivePlayers.filter((q) => q.seat !== from.seat);
      if (!destCands.length) { this.log('【巧变】：没有其他角色的区域可以安置这张牌', 'info'); return; }
      const dsel = await this.ask(mover, { type: 'chooseTargets', player: mover, reason: '巧变：选择移动到的角色', candidates: destCands.map((q) => q.seat), min: 1, max: 1 });
      const dest = dsel && this.players[dsel[0]];
      if (!dest || !dest.alive || dest.seat === from.seat) { this.log('【巧变】：目标区域不合法，牌留在原处', 'info'); return; }
      const card = await this.pickCardFrom(from, mover, { zones: ['equip', 'judge'], reason: '巧变：选择要移动的牌' });
      if (!card) return;
      if (card.type === 'equip' && card.subtype) {
        const slot = card.subtype;
        const old = dest.equips[slot];
        if (old) { dest.equips[slot] = null; this.toDiscard([old]); this.afterLoseCards(dest, [old]); this.log(`${this.nameOf(dest)} 的 ${this.cardText(old)} 被替换弃置`, 'info'); }
        dest.equips[slot] = card;
        this.afterCardGain(dest, [card]);
      } else if (card.type === 'delayed') {
        dest.judges.push(card);
      } else {
        dest.hand.push(card);
        this.afterCardGain(dest, [card]);
      }
      this.log(`${this.nameOf(mover)} 发动【巧变】将 ${this.nameOf(from)} 的 ${this.cardText(card)} 移到 ${this.nameOf(dest)} 的${card.type === 'equip' ? '装备区' : '判定区'}`, 'skill');
      this.emit();
    },

    // 化身：回合开始/结束时替换展示的化身牌及技能（原版两处各限一次）
    async tryHuashenSwap(p, usedKey) {
      if (!has(p, 'huashen') || !p.marks.huashen || p.marks.huashen.options.length <= 1 || p.used[usedKey]) return;
      const r = await this.askOption(p, '【化身】：是否替换当前展示的化身牌？', ['yes', 'no'], ['替换', '不替换']);
      if (r !== 'yes') return;
      p.used[usedKey] = true;
      const sel = await this.ask(p, {
        type: 'chooseOption', player: p, reason: '化身：选择要展示的化身牌',
        options: p.marks.huashen.options.map((o, i) => ({ id: String(i), label: o.general.name })),
      });
      if (sel != null && p.marks.huashen.options[Number(sel)]) await this.applyHuashen(p, Number(sel));
    },

    // ================= 化身 =================
    initHuashen(p) {
      if (p.marks.huashen) return;
      const pool = this.availableGenerals().filter((g) => g.id !== p.general.id);
      const picks = [];
      while (picks.length < 2 && pool.length) picks.push(pool.splice(this.rand(pool.length), 1)[0]);
      // 只建「化身」池，具体获得哪个技能在展示时选择（见 ensureHuashenSkill）
      p.marks.huashen = { options: picks.map((g) => ({ general: g, skill: null })), active: 0 };
    },
    huashenSkillIds(option) {
      if (!option || !option.general) return [];
      return (option.general.skills || []).filter((s) => !!SKILLS[s]);
    },
    // 从当前展示的「化身」牌中选一个技能获得（官方：获得此化身牌上的一个技能）
    async ensureHuashenSkill(p) {
      const h = p.marks.huashen;
      if (!h || !h.options[h.active]) return;
      const cur = h.options[h.active];
      if (cur.skill && p.skills.includes(cur.skill)) return;
      const ids = this.huashenSkillIds(cur);
      if (!ids.length) return;
      let chosen = ids[0];
      if (ids.length > 1) {
        const sel = await this.ask(p, {
          type: 'chooseOption', player: p,
          reason: `【化身】：选择获得 ${cur.general.name} 的一个技能`,
          options: ids.map((id) => ({ id, label: SKILLS[id].name })),
        });
        if (ids.includes(sel)) chosen = sel;
      }
      cur.skill = chosen;
      if (!p.skills.includes(chosen)) p.skills.push(chosen);
      this.log(`${this.nameOf(p)} 化身展示：${cur.general.name}（获得【${SKILLS[chosen].name}】）`, 'skill');
      this.emit();
    },
    async applyHuashen(p, idx) {
      const h = p.marks.huashen;
      if (!h || !h.options[idx]) return;
      const old = h.options[h.active];
      if (old && old.skill && p.skills.includes(old.skill)) p.skills = p.skills.filter((s) => s !== old.skill);
      h.active = idx;
      h.options[idx].skill = null;
      await this.ensureHuashenSkill(p);
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
