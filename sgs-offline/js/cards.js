/* 三国杀 · 单机版 — 卡牌使用、结算、响应询问
 * 依赖 game.js 中的 Game 类，加载后扩展其原型。
 */
(function (global) {
  'use strict';
  const D = global.SGS_DATA;
  const { CARDS, SUITS } = D;
  const Game = global.SGS.Game;

  const EQUIP_SLOT = { weapon: 'weapon', armor: 'armor', offhorse: 'offhorse', defhorse: 'defhorse' };

  // 转化技：手牌 → 视为某牌
  const CONVERSIONS = [
    { skill: 'wusheng', as: 'sha', hand: false, test: (c) => c.color === 'red' },
    { skill: 'longdan', as: 'sha', hand: true, test: (c) => c.name === 'shan' },
    { skill: 'qixi', as: 'guohe', hand: false, test: (c) => c.color === 'black' },
    { skill: 'guose', as: 'lebu', hand: false, test: (c) => c.suit === 'diamond' },
    { skill: 'huoji', as: 'huogong', hand: true, test: (c) => c.color === 'red' && c.type !== 'delayed' },
    { skill: 'lianhuan', as: 'tiesuo', hand: true, test: (c) => c.suit === 'club' },
    { skill: 'duanliang', as: 'bingliang', hand: false, test: (c) => c.color === 'black' && (c.type === 'basic' || c.type === 'equip') },
    { skill: 'jiuchi', as: 'jiu', hand: true, test: (c) => c.suit === 'spade' },
    // 界/Po 变体转化（只有 extras 变体携带 j_ 技能 id）
    { skill: 'j_wusheng', as: 'sha', hand: false, test: (c) => c.color === 'red' },
    { skill: 'j_longdan', as: 'jiu', hand: true, test: (c) => c.name === 'tao' },
  ];

  Object.assign(Game.prototype, {
    // ================= 出牌阶段：可用动作 =================
    buildPlayActions(p) {
      const acts = [];
      const push = (a) => { a.key = a.key || `a${acts.length}`; acts.push(a); };

      for (const c of p.hand) {
        const def = CARDS[c.name];
        // 普通使用
        const normal = this.cardActionFor(p, [c], c.name, null);
        if (normal) push(normal);
        // 斗地主鏖战：桃只能当【杀】或【闪】，出牌阶段提供“桃当杀”
        if (this.ddzFierce && c.name === 'tao') {
          const a = this.cardActionFor(p, [c], 'sha', null);
          if (a) { a.label = '杀（鏖战：桃当杀）'; push(a); }
        }
        // 转化（红颜等改花色技能按实际花色判定）
        const eff = this.effCard(p, c);
        if (p.flags && p.flags.noSkills) continue; // 义绝/铁骑：本回合非锁定技失效
        for (const conv of CONVERSIONS) {
          if (!p.skills.includes(conv.skill)) continue;
          if (!conv.test(eff)) continue;
          const a = this.cardActionFor(p, [c], conv.as, conv.skill);
          if (a) push(a);
        }
      }
      // 装备区的牌也可被转化（武圣/奇袭/国色/断粮）
      for (const c of Object.values(p.equips).filter(Boolean)) {
        if (p.flags && p.flags.noSkills) break; // 义绝/铁骑：本回合非锁定技失效
        const eff = this.effCard(p, c);
        for (const conv of CONVERSIONS) {
          if (!p.skills.includes(conv.skill) || conv.hand) continue;
          if (!conv.test(eff)) continue;
          const a = this.cardActionFor(p, [c], conv.as, conv.skill);
          if (a) push(a);
        }
      }
      // 双雄：与判定牌颜色不同的手牌当【决斗】
      if (p.skills.includes('shuangxiong') && p.flags.shuangxiongColor) {
        for (const c of p.hand) {
          if (c.color !== p.flags.shuangxiongColor) {
            const a = this.cardActionFor(p, [c], 'juedou', 'shuangxiong');
            if (a) { a.label = '双雄：当【决斗】'; push(a); }
          }
        }
      }
      // 筹伐（司马昭）：目标手牌中与展示牌类型不同的牌均视为【杀】
      if (p.marks && p.marks.choufaType) {
        for (const c of p.hand) {
          const tp = (CARDS[c.name] || {}).type;
          if (tp && tp !== p.marks.choufaType) {
            const a = this.cardActionFor(p, [c], 'sha', 'j_choufa');
            if (a) { a.label = '筹伐：视为【杀】'; push(a); }
          }
        }
      }
      // 丈八蛇矛：两张手牌当杀
      if (p.equips.weapon && p.equips.weapon.name === 'zhangba' && p.hand.length >= 2) {
        const legal = this.legalTargetsFor(p, 'sha', null);
        if (legal.length) {
          push({ kind: 'skill', skill: 'zhangba', label: '丈八蛇矛：两张手牌当【杀】', needsCards: { min: 2, max: 2 }, targetCandidates: legal, minTargets: 1, maxTargets: 1 });
        }
      }
      // 朱雀羽扇：普通杀当火杀
      if (p.equips.weapon && p.equips.weapon.name === 'zhuque') {
        for (const c of p.hand) {
          if (c.name === 'sha') {
            const a = this.cardActionFor(p, [c], 'huosha', 'zhuque');
            if (a) { a.label = '杀 → 火杀（朱雀羽扇）'; push(a); }
          }
        }
      }
      // 主动技能
      this.buildSkillActions(p, push);
      push({ kind: 'end', label: '结束出牌' });
      return acts;
    },

    // 某张（组）牌作为 asName 使用时的动作模板
    cardActionFor(p, cards, asName, skill) {
      const def = CARDS[asName];
      if (!def) return null;
      if (asName === 'wuxie') return null; // 无懈只在响应时可用
      if (asName === 'zhadan') return null; // 炸弹只在响应时使用
      if (asName === 'diqi') return null;   // 地契由地主开局自动置入防具栏
      if (asName === 'tao' && this.ddzFierce) return null; // 鏖战：桃只能当杀/闪
      if (asName === 'shan') return null;
      if (def.type === 'basic' && ['sha', 'huosha', 'leisha'].includes(asName) && !this.canUseSlash(p)) return null;
      if (asName === 'jiu' && (p.drank || 0) >= 1) return null;
      if (asName === 'tao' && p.hp >= p.maxHp) return null;
      const targets = this.legalTargetsFor(p, asName, skill, cards);
      const needTarget = ['sha', 'huosha', 'leisha'].includes(asName) || ['juedou', 'guohe', 'shunshou', 'jiedao', 'lebu', 'bingliang', 'huogong', 'tiesuo'].includes(asName);
      if (needTarget && targets.length === 0 && !(asName === 'tiesuo')) return null;
      const a = {
        kind: 'card', subcards: cards.map((c) => c.id), as: asName, skill: skill || null,
        label: (skill ? `【${D.SKILLS[skill] ? D.SKILLS[skill].name : skill}】` : '') + this.cardName(asName),
        targetCandidates: targets, minTargets: 0, maxTargets: 0, needsTargets: false,
      };
      if (['sha', 'huosha', 'leisha'].includes(asName)) {
        a.needsTargets = true; a.minTargets = 1; a.maxTargets = 1;
        // 方天画戟：最后一张手牌可多目标
        if (asName === 'sha' && p.hand.length === 1 && p.equips.weapon && p.equips.weapon.name === 'fangtian') a.maxTargets = Math.min(3, targets.length);
        if (asName === 'sha' && p.flags && p.flags.tianyiWin) a.maxTargets = Math.min(Math.max(a.maxTargets, 1) + 1, targets.length);
        if (p.skills.includes('tianyi') && p.flags.tianyiWin && !p.flags.tianyiUsed) { /* 天义额外目标由技能处理 */ }
      } else if (asName === 'jiedao') {
        a.needsTargets = true; a.minTargets = 2; a.maxTargets = 2;
        a.secondStage = 'jiedao';
        a.label = '借刀杀人：先选持武器者，再选被杀目标';
      } else if (asName === 'tiesuo') {
        a.needsTargets = true; a.minTargets = 0; a.maxTargets = 2;
        a.label = '铁索连环（不选目标则重铸摸一张）';
      } else if (['nanman', 'wanjian', 'taoyuan', 'wugu'].includes(asName)) {
        a.needsTargets = false;
      } else if (needTarget) {
        a.needsTargets = true; a.minTargets = 1; a.maxTargets = 1;
      }
      return a;
    },

    cardName(n) { return CARDS[n] ? '【' + CARDS[n].name + '】' : n; },

    canUseSlash(p) {
      if (p.flags && p.flags.tianyiLose) return false;
      if (p.skills.includes('paoxiao') || p.skills.includes('j_paoxiao')) return true;
      if (p.equips.weapon && p.equips.weapon.name === 'zhugeliannu') return true;
      let limit = 1 + (p.flags && p.flags.extraSlash ? p.flags.extraSlash : 0);
      if (p.skills.includes('j_zhaxiang') && p.flags && p.flags.zhaxiang) limit += 1; // 诈降：本回合杀次数+1
      return (p.slashCount || 0) < limit;
    },

    // 目标合法性
    legalTargetsFor(p, asName, skill, cards) {
      const others = this.alivePlayers.filter((q) => q.seat !== p.seat);
      const c0 = (cards && cards[0]) || null;
      const color = c0 ? this.colorOf(p, c0) : null;
      const isTrick = ['juedou','guohe','shunshou','jiedao','nanman','wanjian','taoyuan','wugu','huogong','lebu','bingliang','tiesuo'].includes(asName);
      const res = [];
      if (['sha', 'huosha', 'leisha'].includes(asName)) {
        const c1 = (cards && cards[0]) || null;
        const zhaRed = !!(p.skills.includes('j_zhaxiang') && p.flags && p.flags.zhaxiang && c1 && this.colorOf(p, c1) === 'red');
        const wsDiamond = !!(p.skills.includes('j_wusheng') && c1 && this.suitOf(p, c1) === 'diamond');
        for (const q of others) {
          if (q.skills.includes('kongcheng') && q.hand.length === 0) continue;
          if ((p.flags && p.flags.tianyiWin) || zhaRed || wsDiamond || this.inAttackRange(p, q)) res.push(q.seat);
        }
      } else if (asName === 'juedou') {
        for (const q of others) {
          if (q.skills.includes('kongcheng') && q.hand.length === 0) continue;
          if (q.skills.includes('weimu') && color === 'black') continue;
          res.push(q.seat);
        }
      } else if (asName === 'guohe') {
        for (const q of others) if (this.allCardsOf(q).length) res.push(q.seat);
      } else if (asName === 'shunshou') {
        const noDist = p.skills.includes('qicai') || p.skills.includes('j_qicai');
        for (const q of others) {
          if (!this.allCardsOf(q).length) continue;
          if (q.skills.includes('qianxun')) continue;
          if (!noDist && this.distance(p, q) > 1) continue;
          res.push(q.seat);
        }
      } else if (asName === 'lebu') {
        for (const q of others) {
          if (q.judges.some((c) => c.name === 'lebu')) continue;
          if (q.skills.includes('qianxun')) continue;
          res.push(q.seat);
        }
      } else if (asName === 'bingliang') {
        const noBingliangDist = p.skills.includes('duanliang') || p.skills.includes('qicai') || p.skills.includes('j_qicai');
        for (const q of others) {
          if (q.judges.some((c) => c.name === 'bingliang')) continue;
          if (!noBingliangDist && this.distance(p, q) > 1) continue;
          res.push(q.seat);
        }
      } else if (asName === 'huogong') {
        for (const q of others) if (q.hand.length) res.push(q.seat);
      } else if (asName === 'jiedao') {
        for (const q of others) if (q.equips.weapon) res.push(q.seat);
      } else if (asName === 'tiesuo') {
        for (const q of this.alivePlayers) res.push(q.seat);
      }
      if (isTrick && color === 'black') return res.filter((s2) => !this.players[s2].skills.includes('weimu'));
      return res;
    },

    legalSecondTargetsFor(p, asName, firstSeat) {
      const a = this.players[firstSeat];
      if (asName === 'jiedao') {
        return this.alivePlayers.filter((q) => q.seat !== a.seat && this.inAttackRange(a, q) && !(q.skills.includes('kongcheng') && q.hand.length === 0)).map((q) => q.seat);
      }
      if (asName === 'lijian') {
        return this.alivePlayers.filter((q) => q.seat !== firstSeat && q.gender === 'male').map((q) => q.seat);
      }
      return [];
    },

    // ================= 执行动作 =================
    async executeAction(p, act) {
      if (!act || act.kind === 'end') return;
      if (act.kind === 'card') return this.useCardAction(p, act);
      if (act.kind === 'skill') return this.useSkillAction(p, act);
    },

    async useCardAction(p, act) {
      const cards = act.subcards.map((id) => this.findCard(p, id)).filter(Boolean);
      if (!cards.length) return;
      let targets = (act.targets || []).map((s) => this.players[s]).filter((q) => q && q.alive);
      // 借刀：目标含第二个
      return this.useVirtualCard(p, cards, act.as, act.skill, targets, act);
    },

    async useVirtualCard(p, cards, asName, skill, targets, act) {
      const def = CARDS[asName];
      if (!def) return;
      const fromHand = cards.filter((c) => p.hand.some((x) => x.id === c.id));
      // 移出手牌
      for (const c of cards) this.removeAnyCard(p, c.id);
      const usedSuit = this.suitOf(p, cards[0]);
      const vc = {
        id: cards[0].id, name: asName, type: def.type, subtype: def.subtype || null,
        suit: usedSuit, rank: cards[0].rank, color: this.colorOf(p, cards[0]),
        cards: cards.slice(), skill, nature: def.nature || 'normal', range: def.range || 0,
        virtual: cards.length > 1 || !!skill,
      };
      this.log(`${this.nameOf(p)} 使用 ${this.cardText(vc)}${skill ? '（' + (D.SKILLS[skill] ? D.SKILLS[skill].name : skill) + '）' : ''}${targets.length ? ' → ' + targets.map((q) => this.nameOf(q)).join('、') : ''}`, 'use');
      this.emit();
      await this.pause(120);
      // 涯角（赵云 Po）：回合外使用手牌时触发
      if (fromHand[0] && this.currentSeat !== p.seat) await this.yajiaoTrigger(p, fromHand[0]);
      // 激昂
      if (!p.flags.noSkills && p.skills.includes('jiang') && (asName === 'juedou' || (['sha','huosha','leisha'].includes(asName) && vc.color === 'red'))) {
        this.drawCards(p, 1, '激昂');
      }
      // 集智
      if (!p.flags.noSkills && p.skills.includes('jizhi') && (def.type === 'trick') && def.type !== 'delayed') {
        this.drawCards(p, 1, '集智');
        this.log(`${this.nameOf(p)} 发动【集智】摸一张牌`, 'skill');
      }
      // 集智（黄月英 Po）：非转化锦囊摸一张；若为基本牌，可弃置之令本回合手牌上限+1
      if (!p.flags.noSkills && p.skills.includes('j_jizhi') && (def.type === 'trick') && def.type !== 'delayed' && !skill) {
        const drawn = this.drawCards(p, 1, '集智');
        this.log(`${this.nameOf(p)} 发动【集智】摸一张牌`, 'skill');
        if (drawn && drawn[0] && drawn[0].type === 'basic' && p.hand.some((c) => c.id === drawn[0].id)) {
          const r = await this.askOption(p, `【集智】：是否弃置刚摸到的 ${this.cardText(drawn[0])}，令本回合手牌上限 +1？`, ['yes', 'no'], ['弃置并+1', '保留']);
          if (r === 'yes') {
            const c = drawn[0];
            p.hand = p.hand.filter((x) => x.id !== c.id);
            this.toDiscard([c]);
            await this.afterLoseCards(p, [c]);
            p.flags = p.flags || {};
            p.flags.jizhiLimit = (p.flags.jizhiLimit || 0) + 1;
            this.log(`${this.nameOf(p)} 发动【集智】弃置 ${this.cardText(c)}，手牌上限 +1`, 'skill');
          }
        }
      }
      // 装备
      if (def.type === 'equip') {
        this.recent.push({ kind: 'use', seat: p.seat, card: cards[0].name, targets: [], gender: p.gender });
        if (this.recent.length > 200) this.recent.shift();
        this.installEquip(p, cards[0]);
        this.toDiscard(cards.slice(1));
        if (fromHand.length) await this.afterLoseCards(p, fromHand, true);
        this.emit();
        return;
      }
      // 延时锦囊
      if (def.type === 'delayed') {
        const target = targets[0] || p;
        this.recent.push({ kind: 'use', seat: p.seat, card: asName, targets: [target.seat], gender: p.gender });
        if (this.recent.length > 200) this.recent.shift();
        target.judges.push(Object.assign({}, vc, { id: cards[0].id, cards: cards.slice(), _orig: cards[0] }));
        // 从手牌移入判定区，不从弃牌堆走
        this.toDiscard(cards.slice(1));
        this.log(`${this.cardText(vc)} 置于 ${this.nameOf(target)} 的判定区`, 'info');
        if (fromHand.length) await this.afterLoseCards(p, fromHand, true);
        this.emit();
        return;
      }
      // 铁索重铸
      if (asName === 'tiesuo' && targets.length === 0) {
        this.toDiscard(cards);
        this.drawCards(p, 1, '铁索重铸');
        this.log(`${this.nameOf(p)} 重铸【铁索连环】摸一张牌`, 'info');
        if (fromHand.length) await this.afterLoseCards(p, fromHand, true);
        this.emit();
        return;
      }
      // AOE / 群体
      if (['nanman', 'wanjian', 'taoyuan', 'wugu'].includes(asName)) {
        targets = this.alivePlayers.filter((q) => (asName === 'taoyuan' || asName === 'wugu') ? true : q.seat !== p.seat);
      }
      // 无中
      if (asName === 'wuzhong') targets = [p];
      if (asName === 'jiu') targets = [p];
      if (asName === 'tao') targets = targets.length ? targets : [p];
      if (targets && targets.length) {
        this.recent.push({ kind: 'use', seat: p.seat, card: asName, targets: targets.map((q) => q.seat), gender: p.gender });
        if (this.recent.length > 200) this.recent.shift();
      }
      // 奋威（甘宁 Po，限定技）：锦囊指定多个目标后，可令任意个目标无效
      if (def.type === 'trick' && targets && targets.length > 1) {
        for (const q of this.alivePlayers.slice()) {
          if (!q.alive || !q.skills.includes('j_fenwei') || q.once.fenwei) continue;
          if (q.flags && q.flags.noSkills) continue;
          const r = await this.askOption(q, `【奋威（限定技）】：是否令 ${this.cardText(vc)} 对任意个目标无效？`, ['yes', 'no'], ['发动', '放弃']);
          if (r !== 'yes') continue;
          q.once.fenwei = true;
          const ts = await this.ask(q, { type: 'chooseTargets', player: q, reason: '奋威：选择令哪些目标无效', candidates: targets.map((t) => t.seat), min: 1, max: targets.length });
          const invalid = (ts || []).slice();
          const removed = targets.filter((t) => invalid.includes(t.seat));
          targets = targets.filter((t) => !invalid.includes(t.seat));
          this.log(`${this.nameOf(q)} 发动【奋威】，令 ${this.cardText(vc)} 对 ${removed.length} 个目标无效`, 'skill');
          this.emit();
          if (!targets.length) break;
        }
      }
      // 冲阵（SP 赵云）：龙胆转化使用时获得对方一张手牌
      if ((skill === 'longdan' || skill === 'j_longdan') && targets && targets[0] && targets[0] !== p) await this.chongzhenGain(p, targets[0]);
      this.table.push(vc);
      await this.resolveVirtualCard(p, vc, targets, act);
      this.table = this.table.filter((c) => c !== vc);
      if (asName === 'nanman' && !vc.keep) {
        if (this.juxiangGain(p, cards)) vc.keep = true;
      }
      if (!vc.keep) this.toDiscard(cards);
      if (fromHand.length) await this.afterLoseCards(p, fromHand, true);
      this.emit();
    },

    // 巨象：其他角色使用的【南蛮入侵】结算结束后，祝融获得之
    juxiangGain(user, cards) {
      const owners = this.alivePlayers.filter((q) => q.skills.includes('juxiang') && q.seat !== user.seat);
      if (!owners.length || !cards || !cards.length) return false;
      for (const q of owners) {
        for (const c of cards) { q.hand.push(c); this.afterCardGain(q, [c]); }
        this.log(`【巨象】${this.nameOf(q)} 获得【南蛮入侵】`, 'skill');
      }
      return true;
    },

    async resolveVirtualCard(p, vc, targets, act) {
      // 谦逊（陆逊 Po）：其他角色的普通锦囊以你为唯一目标并生效时
      if (vc && vc.type === 'trick' && vc.name !== 'wuxie' && Array.isArray(targets) && targets.length === 1) {
        const qt = targets[0];
        if (qt && qt !== p && qt.alive && !qt.flags.noSkills && qt.skills.includes('j_qianxun') && qt.hand.length) await this.qianxunExile(qt);
      }
      const name = vc.name;
      const card = vc;
      switch (name) {
        case 'sha': case 'huosha': case 'leisha':
          await this.resolveSlash(p, vc, targets);
          break;
        case 'tao':
          await this.resolveTao(p, vc, targets[0] || p);
          break;
        case 'jiu': {
          p.drank = (p.drank || 0) + 1;
          this.log(`${this.nameOf(p)} 使用【酒】，本回合下一张【杀】伤害 +1`, 'info');
          // 聚众（农民）：队友使用【酒】时，可弃同名【酒】令下一张【杀】伤害额外 +1
          if (this.ddzMode && p.role === 'farmer') {
            const holder = await this.juzhongEnhance(p, 'jiu');
            if (holder) { p.jiuExtraDamage = (p.jiuExtraDamage || 0) + 1; this.log(`${this.nameOf(holder)} 发动【聚众】令下一张【杀】伤害额外 +1`, 'skill'); }
          }
          break;
        }
        case 'juedou':
          await this.resolveDuel(p, vc, targets[0]);
          break;
        case 'guohe':
          await this.resolveDismantle(p, vc, targets[0], false);
          break;
        case 'shunshou':
          await this.resolveDismantle(p, vc, targets[0], true);
          break;
        case 'wuzhong': {
          // 【无中生有】同样可被【无懈可击】抵消（无懈链对全体存活角色询问）
          const target = targets[0] || p;
          if (await this.isNullified(vc, target, p)) {
            this.log(`【无中生有】被【无懈可击】抵消，${this.nameOf(target)} 不摸牌`, 'wuxie');
            break;
          }
          this.drawCards(p, 2, '无中生有');
          break;
        }
        case 'jiedao':
          await this.resolveCollateral(p, vc, targets);
          break;
        case 'nanman':
          await this.resolveAOE(p, vc, targets, 'sha', 1);
          break;
        case 'wanjian':
          await this.resolveAOE(p, vc, targets, 'shan', 1);
          break;
        case 'taoyuan':
          for (const q of targets) {
            if (!q.alive) continue;
            if (await this.isNullified(vc, q, p)) continue;
            if (q.hp < q.maxHp) await this.recover(q, 1, p, '桃园结义');
          }
          break;
        case 'wugu':
          await this.resolveWugu(p, vc, targets);
          break;
        case 'huogong':
          await this.resolveFireAttack(p, vc, targets[0]);
          break;
        case 'tiesuo':
          for (const q of targets) {
            if (!q.alive) continue;
            if (await this.isNullified(vc, q, p)) continue;
            q.chained = !q.chained;
            this.log(`${this.nameOf(q)} ${q.chained ? '横置' : '重置'}`, 'info');
          }
          break;
        case 'lebu': case 'bingliang':
          // 已在 useVirtualCard 中放入判定区
          break;
        case 'wuxie':
          break;
        // ===== 斗地主专属牌（6100-6103）=====
        case 'gongshoujianbei': {
          const opt = await this.askOption(p, '【攻守兼备】：选择一项', ['wanjian', 'taoyuan'], ['当【万箭齐发】', '当【桃园结义】']);
          if (opt === 'taoyuan') await this.resolveVirtualCard(p, Object.assign({}, vc, { name: 'taoyuan' }), this.alivePlayers.slice(), {});
          else await this.resolveVirtualCard(p, Object.assign({}, vc, { name: 'wanjian' }), this.alivePlayers.filter((q) => q.seat !== p.seat), {});
          break;
        }
        case 'jintuiziru': {
          const opt = await this.askOption(p, '【进退自如】：选择一项', ['nanman', 'wugu'], ['当【南蛮入侵】', '当【五谷丰登】']);
          if (opt === 'wugu') await this.resolveVirtualCard(p, Object.assign({}, vc, { name: 'wugu' }), this.alivePlayers.slice(), {});
          else await this.resolveVirtualCard(p, Object.assign({}, vc, { name: 'nanman' }), this.alivePlayers.filter((q) => q.seat !== p.seat), {});
          break;
        }
        case 'jiwangkailai': {
          // 选项1：弃置所有手牌，然后摸等量张牌；选项2（将所有手牌当普通锦囊）未实现
          const hand = p.hand.slice();
          if (hand.length) {
            p.hand = p.hand.filter((c) => !hand.some((x) => x.id === c.id));
            this.toDiscard(hand);
            await this.afterLoseCards(p, hand);
          }
          this.drawCards(p, hand.length, '继往开来');
          this.log(`【继往开来】：弃置 ${hand.length} 张手牌并摸 ${hand.length} 张（“将手牌当锦囊”未实现）`, 'skill');
          break;
        }
        default:
          break;
      }
    },

    // ===== 斗地主【炸弹】=====
    // 敌方角色一张牌生效前，可弃置炸弹抵消；使用后不能被无懈响应，底价加倍（不超上限）
    async askZhaden(card, source) {
      if (!this.ddzMode || !card || !source) return false;
      const srcIsLandlord = source.role === 'landlord';
      const owners = this.alivePlayers.filter((q) => {
        if (q.seat === source.seat) return false;
        if ((q.role === 'landlord') === srcIsLandlord) return false; // 只 Ask 敌方
        return q.hand.some((c) => c.name === 'zhadan');
      });
      for (const q of owners) {
        const r = await this.askOption(q, `【炸弹】：是否抵消 ${this.nameOf(source)} 的 ${this.cardText(card)}？（不能被无懈响应）`, ['yes', 'no'], ['使用炸弹', '不使用']);
        if (r !== 'yes') continue;
        const bomb = q.hand.find((c) => c.name === 'zhadan');
        q.hand = q.hand.filter((c) => c !== bomb);
        this.toDiscard([bomb]);
        const m = this.doubleDdzBase();
        this.log(`${this.nameOf(q)} 使用【炸弹】抵消了 ${this.cardText(card)}，底价加倍至 ×${m}`, 'skill');
        this.recent.push({ kind: 'use', seat: q.seat, card: 'zhadan', targets: [], gender: q.gender });
        if (this.recent.length > 200) this.recent.shift();
        this.emit();
        return true;
      }
      return false;
    },

    // ================= 无懈可击 =================
    async isNullified(card, target, source) {
      if (!['trick', 'delayed'].includes(card.type) || card.name === 'wuxie') return false;
      // 斗地主【炸弹】：敌方一张牌生效前抵消，且不能被【无懈可击】响应
      if (await this.askZhaden(card, source)) return true;
      let negated = false;
      let depth = 0;
      while (depth++ < 10) {
        let played = null;
        for (const q of this.alivePlayers) {
          if (!this.canPlayWuxie(q)) continue;
          const r = await this.askWuxie(q, card, target, negated);
          if (r) { played = { q, r }; break; }
        }
        if (!played) break;
        // 打出无懈
        const pr = played.r.cards.map((id) => q_find(played.q, id)).filter(Boolean);
        played.q.hand = played.q.hand.filter((c) => !pr.some((x) => x.id === c.id));
        this.toDiscard(pr);
        if (pr[0]) await this.yajiaoTrigger(played.q, pr[0]);
        negated = !negated;
        const wt = target ? `（目标：${this.nameOf(target)}）` : '';
        this.log(`${this.nameOf(played.q)} 使用【无懈可击】${negated ? '抵消' : '反抵消'}了 ${this.cardText(card)}${wt}`, 'wuxie');
        this.recent.push({ kind: 'use', seat: played.q.seat, card: 'wuxie', targets: [], gender: played.q.gender });
        if (this.recent.length > 200) this.recent.shift();
        this.emit();
        await this.pause(160);
      }
      return negated;
    },

    canPlayWuxie(q) {
      return q.hand.some((c) => c.name === 'wuxie') || (q.skills.includes('kanpo') && q.hand.some((c) => c.color === 'black'));
    },

    async askWuxie(q, card, target, negated) {
      if (q.flags && q.flags.noHand) return null; // 义绝（黑）：不能使用或打出手牌
      const opts = [];
      for (const c of q.hand) {
        if (c.name === 'wuxie') opts.push({ cardId: c.id, as: 'wuxie', skill: null });
        else if (q.skills.includes('kanpo') && c.color === 'black') opts.push({ cardId: c.id, as: 'wuxie', skill: 'kanpo' });
      }
      if (!opts.length) return null;
      const res = await this.ask(q, {
        type: 'response', player: q, need: 'wuxie', options: opts,
        reason: `${this.cardText(card)} 对 ${this.nameOf(target)} ${negated ? '已被抵消' : '即将生效'}，是否使用【无懈可击】？`,
        card, targetSeat: target.seat, negated,
      });
      if (!res || res.cardId == null) return null;
      return { cards: [res.cardId], as: 'wuxie', skill: res.skill };
    },

    // ================= 杀 =================
    async resolveSlash(p, vc, targets) {
      // 酒（含聚众强化）对下一张【杀】的额外伤害，只在该【杀】结算时消耗
      const jiuExtra = p.jiuExtraDamage || 0;
      p.jiuExtraDamage = 0;
      const paoBonus = (p.skills.includes('j_paoxiao') && p.flags && p.flags.paoNext) ? 1 : 0;
      if (paoBonus && p.flags) p.flags.paoNext = false;
      const bonus = (p.damageBonus || 0) + (p.drank ? 1 : 0) + jiuExtra + paoBonus;
      if (p.drank) { p.drank = 0; this.log('【酒】效果生效', 'info'); }
      p.slashCount = (p.slashCount || 0) + 1;
      // 斗地主【炸弹】：可抵消敌方使用的【杀】
      if (this.ddzMode && await this.askZhaden(vc, p)) return;
      // 聚众（农民）：队友使用【杀】时，可弃一张同名【杀】令此【杀】伤害 +1
      // 鏖战期由【桃】充当的【杀】不可聚众（“桃…不可聚众或响应聚众”）
      const physicalTao = this.ddzFierce && vc.cards && vc.cards[0] && vc.cards[0].name === 'tao';
      if (this.ddzMode && !physicalTao && ['sha', 'huosha', 'leisha'].includes(vc.name)) {
        const holder = await this.juzhongEnhance(p, vc.name);
        if (holder) { vc._juzhongBonus = 1; this.log(`${this.nameOf(holder)} 发动【聚众】令此【杀】伤害 +1`, 'skill'); }
      }
      await this.jijiangReward(p);
      for (let target of targets) {
        if (!target.alive) continue;
        // 铁骑（马超 Po）：令其本回合非锁定技失效并判定，未弃同花色牌则不能闪
        let noShan = false;
        if (!p.flags.noSkills && p.skills.includes('j_tieji')) {
          const inv = await this.askOption(p, `【铁骑】：是否令 ${this.nameOf(target)} 本回合非锁定技失效并判定？`, ['yes', 'no'], ['发动', '放弃']);
          if (inv === 'yes') {
            if (!target.flags) target.flags = {};
            target.flags.noSkills = true;
            const j = await this.judge(p, '铁骑');
            const suit = j.card.suit;
            const pool = [...target.hand, ...Object.values(target.equips).filter(Boolean)].filter((c) => this.suitOf(target, c) === suit);
            let discarded = false;
            if (pool.length) {
              const sel = await this.ask(target, { type: 'chooseCards', player: target, reason: `铁骑：弃置一张${D.SUITS[suit] ? D.SUITS[suit].name : ''}牌，否则不能使用【闪】`, cards: pool, min: 1, max: 1 });
              const c = sel && sel.length ? this.findCard(target, sel[0].id) : null;
              if (c) {
                this.removeAnyCard(target, c.id);
                this.toDiscard([c]);
                await this.afterLoseCards(target, [c]);
                discarded = true;
              }
            }
            if (!discarded) noShan = true;
            this.log(`【铁骑】判定为 ${this.cardText(j.card)}，${discarded ? `${this.nameOf(target)} 弃置同花色牌` : `${this.nameOf(target)} 不能使用【闪】`}`, 'skill');
          }
        }
        // 铁骑
        if (!p.flags.noSkills && p.skills.includes('tieji')) {
          const inv = await this.askOption(p, '是否发动【铁骑】进行判定？', ['yes', 'no'], ['发动', '放弃']);
          if (inv === 'yes') {
            const j = await this.judge(p, '铁骑');
            if (j.card.color === 'red') { noShan = true; this.log('【铁骑】判定为红色，目标不能使用【闪】', 'skill'); }
          }
        }
        // 流离
        if (!target.flags.noSkills && target.skills.includes('liuli') && target.hand.length + Object.values(target.equips).filter(Boolean).length > 0) {
          const liuliTargets = this.alivePlayers.filter((q) => q.seat !== target.seat && q.seat !== p.seat && this.inAttackRange(target, q) && !(q.skills.includes('kongcheng') && q.hand.length === 0));
          if (liuliTargets.length) {
            const r = await this.ask(target, {
              type: 'chooseOption', player: target,
              reason: `你成为【杀】的目标，是否发动【流离】弃一张牌转移此【杀】？`,
              options: [{ id: 'yes', label: '发动流离' }, { id: 'no', label: '不发动' }],
            });
            if (r === 'yes') {
              const cards = await this.ask(target, { type: 'chooseCards', player: target, reason: '流离：弃置一张牌', cards: this.selectableCards(target), min: 1, max: 1 });
              if (cards && cards.length) {
                const chosen = cards[0];
                const moved = this.removeAnyCard(target, chosen.id);
                if (moved) { this.toDiscard([moved]); this.afterLoseCards(target, [moved]); }
                else this.log(`流离选牌失败：${chosen && chosen.id}`, 'info');
                const t2 = await this.ask(target, { type: 'chooseTargets', player: target, reason: '流离：选择转移目标', candidates: liuliTargets.map((q) => q.seat), min: 1, max: 1 });
                const nt = t2 && this.players[t2[0]];
                if (nt) {
                  this.log(`${this.nameOf(target)} 发动【流离】，将【杀】转移给 ${this.nameOf(nt)}`, 'skill');
                  target = nt;
                }
              }
            }
          }
        }
        // 激昂：成为红色【杀】的目标后摸一张
        if (!target.flags.noSkills && target.skills.includes('jiang') && vc.color === 'red' && ['sha', 'huosha', 'leisha'].includes(vc.name)) {
          this.drawCards(target, 1, '激昂');
          this.log(`${this.nameOf(target)} 因【激昂】摸一张牌`, 'skill');
        }
        // 防具
        const armor = target.equips.armor;
        const ignoreArmor = p.equips.weapon && p.equips.weapon.name === 'qinggang';
        if (armor && !ignoreArmor) {
          if (armor.name === 'renwang' && vc.color === 'black') { this.log(`【仁王盾】令黑色【杀】对 ${this.nameOf(target)} 无效`, 'info'); continue; }
          if (armor.name === 'tengjia' && vc.nature === 'normal') { this.log(`【藤甲】令普通【杀】对 ${this.nameOf(target)} 无效`, 'info'); continue; }
        }
        // 雌雄双股剑
        if (p.equips.weapon && p.equips.weapon.name === 'cixiong' && p.gender !== target.gender) {
          const r = await this.ask(target, {
            type: 'chooseOption', player: target, reason: '【雌雄双股剑】：弃置一张手牌，或令对方摸一张牌',
            options: target.hand.length ? [{ id: 'discard', label: '弃置一张手牌' }, { id: 'draw', label: '令对方摸牌' }] : [{ id: 'draw', label: '令对方摸牌' }],
          });
          if (r === 'discard' && target.hand.length) {
            const sel = await this.ask(target, { type: 'chooseCards', player: target, reason: '雌雄双股剑：弃置一张手牌', cards: target.hand.slice(), min: 1, max: 1 });
            const pick = (sel || []).map((x) => this.findCard(target, x.id)).filter(Boolean).slice(0, 1);
            if (pick.length) {
              this.removeAnyCard(target, pick[0].id);
              this.toDiscard(pick);
              this.afterLoseCards(target, pick);
            }
          } else {
            this.drawCards(p, 1, '雌雄双股剑');
          }
        }
        // 享乐
        if (!target.flags.noSkills && target.skills.includes('xiangle')) {
          const basic = p.hand.filter((c) => c.type === 'basic');
          const r = await this.ask(p, {
            type: 'chooseOption', player: p, reason: `【享乐】：是否弃置一张基本牌？否则此【杀】对 ${this.nameOf(target)} 无效`,
            options: basic.length ? [{ id: 'discard', label: '弃置一张基本牌' }, { id: 'skip', label: '不弃置（杀无效）' }] : [{ id: 'skip', label: '不弃置（杀无效）' }],
          });
          if (r !== 'discard' || !basic.length) { this.log(`【享乐】令此【杀】对 ${this.nameOf(target)} 无效`, 'info'); continue; }
          const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: '享乐：弃置一张基本牌', cards: basic, min: 1, max: 1 });
          if (!sel || !sel.length) continue;
          const bc = p.hand.find((c) => c.id === sel[0].id);
          p.hand = p.hand.filter((c) => c !== bc); this.toDiscard([bc]); this.afterLoseCards(p, [bc]);
        }
        // 烈弓
        if (!p.flags.noSkills && p.skills.includes('liegong') && (target.hand.length >= p.hp || target.hand.length <= this.attackRange(p))) {
          const r = await this.askOption(p, `【烈弓】：是否令 ${this.nameOf(target)} 不能使用【闪】？`, ['yes', 'no'], ['发动', '不发动']);
          if (r === 'yes') { noShan = true; this.log(`【烈弓】：${this.nameOf(target)} 不能使用【闪】`, 'skill'); }
        }
        // 烈弓（黄忠 Po）：仅出牌阶段触发（与基础 liegong 的时机差异）
        if (!p.flags.noSkills && p.skills.includes('j_liegong') && this.phase === 'play' && (target.hand.length >= p.hp || target.hand.length <= this.attackRange(p))) {
          const r = await this.askOption(p, `【烈弓】：是否令 ${this.nameOf(target)} 不能使用【闪】？`, ['yes', 'no'], ['发动', '不发动']);
          if (r === 'yes') { noShan = true; this.log(`【烈弓（出牌阶段）】：${this.nameOf(target)} 不能使用【闪】`, 'skill'); }
        }
        // 诈降：本回合红色【杀】不能被抵消
        if (p.skills.includes('j_zhaxiang') && p.flags && p.flags.zhaxiang && vc.color === 'red') {
          noShan = true;
          this.log('【诈降】：红色【杀】不能被抵消', 'skill');
        }
        // 询问闪
        let dodged = false;
        if (!noShan) {
          let need = (p.skills.includes('wushuang') ? 2 : 1);
          if ((target.skills.includes('rourin') && p.gender === 'female') || (p.skills.includes('rourin') && target.gender === 'female')) need = 2;
          dodged = true;
          for (let i = 0; i < need; i++) {
            const ok = await this.askForShan(target, { source: p, card: vc, ignoreArmor, reason: `对 ${this.nameOf(p)} 的【杀】使用【闪】${need > 1 ? `（${i + 1}/${need}）` : ''}` });
            if (!ok) { dodged = false; break; }
          }
        }
        if (dodged) {
          this.log(`${this.nameOf(target)} 抵消了【杀】`, 'info');
          if (!p.flags.noSkills && p.skills.includes('j_paoxiao')) {
            p.flags = p.flags || {};
            p.flags.paoNext = true;
            this.log(`${this.nameOf(p)} 发动【咆哮】，本回合下一张【杀】伤害+1`, 'skill');
          }
          if (p.skills.includes('mengjin') && this.allCardsOf(target).length) {
            const r = await this.askOption(p, '是否发动【猛进】弃置目标一张牌？', ['yes', 'no'], ['发动', '放弃']);
            if (r === 'yes') {
              const c = await this.pickCardFrom(target, p, { reason: '猛进：弃置一张牌' });
              if (c) { this.toDiscard([c]); this.afterLoseCards(target, [c]); }
            }
          }
          // 青龙偃月刀
          if (p.equips.weapon && p.equips.weapon.name === 'qinglong' && p.hand.some((c) => ['sha', 'huosha', 'leisha'].includes(c.name) || (p.skills.includes('wusheng') || p.skills.includes('j_wusheng')) && c.color === 'red')) {
            const r = await this.askOption(p, '是否发动【青龙偃月刀】对同一目标再使用一张【杀】？', ['yes', 'no'], ['发动', '放弃']);
            if (r === 'yes') {
              const shaCard = p.hand.find((c) => ['sha', 'huosha', 'leisha'].includes(c.name)) || p.hand.find((c) => c.color === 'red');
              if (shaCard) {
                p.hand = p.hand.filter((c) => c.id !== shaCard.id);
                const vc2 = { id: shaCard.id, name: ['sha', 'huosha', 'leisha'].includes(shaCard.name) ? shaCard.name : 'sha', type: 'basic', nature: shaCard.nature || 'normal', suit: shaCard.suit, rank: shaCard.rank, color: shaCard.color, cards: [shaCard] };
                this.table.push(vc2);
                await this.resolveSlash(p, vc2, [target]);
                this.table = this.table.filter((c) => c !== vc2);
                this.toDiscard([shaCard]);
              }
            }
          }
          // 贯石斧
          if (p.equips.weapon && p.equips.weapon.name === 'guanshi') {
            // 官方：弃置两张牌可包含贯石斧本身
            const pool = this.selectableCards(p);
            if (pool.length >= 2) {
              const r = await this.askOption(p, '是否发动【贯石斧】弃两张牌令此【杀】依然造成伤害？', ['yes', 'no'], ['发动', '放弃']);
              if (r === 'yes') {
                const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: '贯石斧：弃置两张牌', cards: pool, min: 2, max: 2 });
                const moved = (sel || []).slice(0, 2).map((c) => this.removeAnyCard(p, c.id)).filter(Boolean);
                this.toDiscard(moved);
                this.afterLoseCards(p, moved);
                dodged = false;
              }
            }
          }
          if (dodged) continue;
        }
        // 命中
        let dmg = 1 + bonus + (vc._juzhongBonus || 0);
        if (p.skills.includes('j_luoyi') && p.flags && p.flags.luoyiBonus) dmg += 1; // 裸衣（许褚 Po）
        if (p.flags && p.flags.yijueTargets && p.flags.yijueTargets[target.seat] && vc.suit === 'heart') dmg += 1; // 义绝（黑）：红桃杀 +1
        if (p.equips.weapon && p.equips.weapon.name === 'gudingdao' && target.hand.length === 0) { dmg += 1; this.log('【古锭刀】目标无手牌，伤害 +1', 'info'); }
        // 寒冰剑
        if (p.equips.weapon && p.equips.weapon.name === 'hanbing' && this.allCardsOf(target).length > 0) {
          const r = await this.askOption(p, '是否发动【寒冰剑】防止伤害，改为弃置目标两张牌？', ['yes', 'no'], ['发动', '放弃']);
          if (r === 'yes') {
            for (let i = 0; i < 2; i++) {
              const pick = await this.pickCardFrom(target, p, { reason: '寒冰剑：弃置一张牌' });
              if (pick) { this.toDiscard([pick]); this.afterLoseCards(target, [pick]); }
            }
            continue;
          }
        }
        // 麒麟弓
        if (p.equips.weapon && p.equips.weapon.name === 'qilin' && (target.equips.offhorse || target.equips.defhorse)) {
          const r = await this.askOption(p, '是否发动【麒麟弓】弃置目标一张坐骑？', ['yes', 'no'], ['发动', '放弃']);
          if (r === 'yes') {
            const slot = target.equips.defhorse ? 'defhorse' : 'offhorse';
            const c = target.equips[slot];
            target.equips[slot] = null;
            this.toDiscard([c]);
            this.afterLoseCards(target, [c]);
          }
        }
        await this.damage({ source: p, target, amount: dmg, nature: vc.nature || 'normal', card: vc });
        if (target.alive && p.alive && p.skills.includes('lieren') && this.allCardsOf(target).length) {
          const win = await this.pindian(p, target, '烈刃');
          if (win) {
            const c = await this.pickCardFrom(target, p, { reason: '烈刃：获得一张牌' });
            if (c) { p.hand.push(c); this.afterCardGain(p, [c]); this.log(`${this.nameOf(p)} 发动【烈刃】获得一张牌`, 'skill'); }
          }
        }
      }
    },

    async resolveTao(p, vc, target) {
      if (await this.isNullified(vc, target, p)) return;
      let heal = 1;
      if (target.skills.includes('jiuyuan') && target.role === 'lord' && p.kingdom === '吴' && p.seat !== target.seat) heal += 1;
      const healed = await this.recover(target, heal, p, '桃');
      // 聚众（农民）：队友使用【桃】生效后，可弃同名【桃】令使用者摸两张牌
      if (healed > 0 && this.ddzMode && p.role === 'farmer') {
        const holder = await this.juzhongEnhance(p, 'tao');
        if (holder) { this.drawCards(p, 2, '聚众'); this.log(`${this.nameOf(holder)} 发动【聚众】令 ${this.nameOf(p)} 摸两张牌`, 'skill'); }
      }
    },

    async resolveDuel(p, vc, target) {
      if (!target || !target.alive) return;
      if (vc.id !== -2 && await this.isNullified(vc, target, p)) return;
      // 激昂：成为【决斗】的目标后摸一张
      if (target.skills.includes('jiang')) {
        this.drawCards(target, 1, '激昂');
        this.log(`${this.nameOf(target)} 因【激昂】摸一张牌`, 'skill');
      }
      let first = target, second = p;
      let guard = 0;
      while (guard++ < 30) {
        if (!first.alive) break;
        const need = second.skills.includes('wushuang') ? 2 : 1;
        let ok = true;
        for (let i = 0; i < need; i++) {
          const r = await this.askForSha(first, { reason: `【决斗】：对 ${this.nameOf(second)} 打出【杀】${need > 1 ? `（${i + 1}/${need}）` : ''}`, duel: true, opponent: second.seat });
          if (!r) { ok = false; break; }
        }
        if (!ok) break;
        [first, second] = [second, first];
      }
      const bonus = (second === p && p.damageBonus) ? p.damageBonus : 0;
      const luoyi = (second && second.flags && second.flags.luoyiBonus) ? 1 : 0; // 裸衣（许褚 Po）
      await this.damage({ source: second, target: first, amount: 1 + bonus + luoyi, card: vc });
    },

    async resolveDismantle(p, vc, target, gain) {
      if (!target || !target.alive) return;
      if (await this.isNullified(vc, target, p)) return;
      const card = await this.pickCardFrom(target, p, { reason: gain ? '顺手牵羊：选择获得一张牌' : '过河拆桥：选择弃置一张牌' });
      if (!card) return;
      if (gain) {
        p.hand.push(card);
        this.afterCardGain(p, [card]);
        this.log(`${this.nameOf(p)} 获得 ${this.nameOf(target)} 一张牌`, 'info');
      } else {
        this.toDiscard([card]);
        this.log(`${this.nameOf(p)} 弃置 ${this.nameOf(target)} 一张牌`, 'info');
      }
      this.afterLoseCards(target, [card]);
      this.emit();
    },

    async resolveCollateral(p, vc, targets) {
      const killer = targets[0], victim = targets[1];
      if (!killer || !killer.alive) return;
      if (await this.isNullified(vc, killer, p)) return;
      if (!victim || !victim.alive) {
        if (killer.equips.weapon) { this.gainCardFromEquip(p, killer, 'weapon'); }
        return;
      }
      let used = false;
      // 空城：没有手牌时不能成为【杀】的目标，借刀无法生效
      const blocked = victim.skills.includes('kongcheng') && victim.hand.length === 0;
      if (blocked) this.log(`【借刀杀人】的目标 ${this.nameOf(victim)} 处于【空城】，无法对其使用【杀】`, 'info');
      if (!blocked && this.inAttackRange(killer, victim)) {
        const r = await this.askForSha(killer, { reason: `【借刀杀人】：对 ${this.nameOf(victim)} 使用一张【杀】，否则将武器交给 ${this.nameOf(p)}`, forcedTarget: victim.seat, mustUse: false, opponent: victim.seat });
        if (r) {
          used = true;
          const vc2 = { id: -6, name: r.name || 'sha', type: 'basic', nature: r.nature || 'normal', suit: 'none', rank: 0, color: 'none', cards: [] };
          this.table.push(vc2);
          await this.resolveSlash(killer, vc2, [victim]);
          this.table = this.table.filter((c) => c !== vc2);
        }
      }
      if (!used && killer.equips.weapon) {
        this.gainCardFromEquip(p, killer, 'weapon');
        this.log(`${this.nameOf(killer)} 未使用【杀】，武器交给 ${this.nameOf(p)}`, 'info');
      }
    },

    gainCardFromEquip(to, from, slot) {
      const c = from.equips[slot];
      if (!c) return;
      from.equips[slot] = null;
      to.hand.push(c);
      this.afterCardGain(to, [c]);
      this.afterLoseCards(from, [c]);
      this.emit();
    },

    async resolveAOE(p, vc, targets, need, dmg) {
      this.groupWaiting = targets.filter((q) => q.alive).map((q) => q.seat);
      this.emit();
      try {
        for (const q of targets) {
          if (!q.alive) { this.groupWaiting = this.groupWaiting.filter((x) => x !== q.seat); this.emit(); continue; }
          if (await this.isNullified(vc, q, p)) { this.groupWaiting = this.groupWaiting.filter((x) => x !== q.seat); this.emit(); continue; }
          const armor = q.equips.armor;
          if (armor && armor.name === 'tengjia') { this.log(`【藤甲】令 ${this.cardText(vc)} 对 ${this.nameOf(q)} 无效`, 'info'); this.groupWaiting = this.groupWaiting.filter((x) => x !== q.seat); this.emit(); continue; }
          if (q.skills.includes('weimu') && vc.color === 'black') { this.log(`【帷幕】令 ${this.cardText(vc)} 对 ${this.nameOf(q)} 无效`, 'info'); this.groupWaiting = this.groupWaiting.filter((x) => x !== q.seat); this.emit(); continue; }
          if (vc.name === 'nanman' && (q.skills.includes('juxiang') || q.skills.includes('huoshou'))) { this.log(`【${q.skills.includes('juxiang') ? '巨象' : '祸首'}】令【南蛮入侵】对 ${this.nameOf(q)} 无效`, 'info'); this.groupWaiting = this.groupWaiting.filter((x) => x !== q.seat); this.emit(); continue; }
          let ok = false;
          if (need === 'sha') ok = !!(await this.askForSha(q, { reason: `【${CARDS[vc.name].name}】：打出一张【杀】，否则受到 1 点伤害`, opponent: p.seat }));
          else ok = await this.askForShan(q, { source: p, card: vc, reason: `【${CARDS[vc.name].name}】：使用一张【闪】，否则受到 1 点伤害` });
          if (!ok) {
            let src = p;
            if (vc.name === 'nanman') { const hs = this.alivePlayers.find((x) => x.skills.includes('huoshou')); if (hs && hs.seat !== q.seat) src = hs; }
            await this.damage({ source: src, target: q, amount: dmg, card: vc });
          }
          this.groupWaiting = this.groupWaiting.filter((x) => x !== q.seat);
          this.emit();
        }
      } finally {
        this.groupWaiting = [];
        this.emit();
      }
    },

    async resolveWugu(p, vc, targets) {
      const n = targets.length;
      const reveal = [];
      for (let i = 0; i < n; i++) {
        if (this.deck.length === 0) this.reshuffle();
        if (!this.deck.length) break;
        reveal.push(this.deck.pop());
      }
      this.log(`【五谷丰登】亮出：${reveal.map((c) => this.cardText(c)).join('、')}`, 'info');
      this.emit();
      const pool = reveal.slice();
      this.groupWaiting = targets.filter((q) => q.alive).map((q) => q.seat);
      this.emit();
      try {
        for (const q of targets) {
          if (!q.alive || !pool.length) { this.groupWaiting = this.groupWaiting.filter((x) => x !== q.seat); this.emit(); continue; }
          if (await this.isNullified(vc, q, p)) { this.groupWaiting = this.groupWaiting.filter((x) => x !== q.seat); this.emit(); continue; }
          const pickId = await this.ask(q, { type: 'pickFrom', player: q, cards: pool.slice(), reason: '五谷丰登：选择一张牌获得' });
          const idx = pool.findIndex((c) => c.id === pickId);
          const c = idx >= 0 ? pool.splice(idx, 1)[0] : pool.shift();
          q.hand.push(c);
          this.afterCardGain(q, [c]);
          this.log(`${this.nameOf(q)} 获得 ${this.cardText(c)}`, 'info');
          this.groupWaiting = this.groupWaiting.filter((x) => x !== q.seat);
          this.emit();
        }
      } finally {
        this.groupWaiting = [];
        this.emit();
      }
      this.toDiscard(pool);
    },

    async resolveFireAttack(p, vc, target) {
      if (!target || !target.hand.length) return;
      if (await this.isNullified(vc, target, p)) return;
      if (!target.hand.length) { this.log('【火攻】目标已无手牌，效果结束', 'info'); return; }
      // 目标自己选择展示哪一张手牌（原版由被火攻者选择，不能由系统随机）
      const pick = await this.ask(target, {
        type: 'chooseCards', player: target,
        reason: '火攻：请选择一张手牌展示',
        cards: target.hand.slice(), min: 1, max: 1,
      });
      const shown = (pick && pick.length) ? (target.hand.find((c) => c.id === pick[0].id) || pick[0]) : target.hand[0];
      if (!shown) return;
      const shownSuit = this.suitOf(target, shown);
      this.log(`${this.nameOf(target)} 展示了 ${this.cardText(shown)}${shownSuit !== shown.suit ? '（视为' + SUITS[shownSuit].name + '）' : ''}`, 'info');
      this.recent.push({ kind: 'handReveal', seat: target.seat, card: { name: shown.name, suit: shown.suit, rank: shown.rank, color: shown.color }, reason: '火攻 · 展示手牌' });
      if (this.recent.length > 200) this.recent.shift();
      this.emit();
      const pool = p.hand.filter((c) => this.suitOf(p, c) === shownSuit);
      if (!pool.length) { this.log(`${this.nameOf(p)} 没有同花色手牌，火攻未造成伤害`, 'info'); return; }
      const sel = await this.ask(p, { type: 'chooseCards', player: p, reason: `火攻：弃置一张${SUITS[shownSuit].name}手牌以造成伤害（否则放弃）`, cards: pool, min: 0, max: 1 });
      if (sel && sel.length) {
        const c = p.hand.find((x) => x.id === sel[0].id);
        p.hand = p.hand.filter((x) => x !== c);
        this.toDiscard([c]);
        await this.damage({ source: p, target, amount: 1, nature: 'fire', card: vc });
      }
    },

    // ================= 装备 =================
    installEquip(p, card) {
      const slot = card.subtype;
      if (!EQUIP_SLOT[slot]) { this.toDiscard([card]); return; }
      const old = p.equips[slot];
      if (old) {
        p.equips[slot] = null;
        if (old.name === 'diqi') { this.destroyCard(old); this.log('【地契】离开防具栏，销毁', 'info'); }
        else { this.toDiscard([old]); this.afterLoseCards(p, [old]); }
      }
      p.equips[slot] = card;
      this.log(`${this.nameOf(p)} 装备 ${this.cardText(card)}`, 'equip');
      this.emit();
    },

    selectableCards(p) {
      return [...p.hand, ...Object.values(p.equips).filter(Boolean)];
    },
    removeAnyCard(p, id) {
      const h = p.hand.find((c) => c.id === id);
      if (h) { p.hand = p.hand.filter((c) => c.id !== id); return h; }
      for (const k of Object.keys(p.equips)) {
        if (p.equips[k] && p.equips[k].id === id) { const c = p.equips[k]; p.equips[k] = null; return c; }
      }
      return null;
    },

    // 响应牌也写出牌事件，UI 才会播卡牌语音
    pushResponseCard(p, name) {
      if (!p || !name) return;
      this.recent.push({ kind: 'use', seat: p.seat, card: name, targets: [], gender: p.gender });
      if (this.recent.length > 200) this.recent.shift();
      this.emit();
    },

    // ================= 响应：闪 =================
    async askForShan(target, ctx) {
      if (!target.alive) return false;
      // 八卦阵 / 八阵
      const armor = target.equips.armor;
      const hasBagua = (armor && armor.name === 'bagua') || (!armor && target.skills.includes('bazhen'));
      if (hasBagua && !ctx.ignoreArmor) {
        const r = await this.askOption(target, '是否发动【八卦阵】进行判定，若为红色则视为使用【闪】？', ['yes', 'no'], ['发动八卦阵', '不发动']);
        if (r === 'yes') {
          const j = await this.judge(target, armor && armor.name === 'bagua' ? '八卦阵' : '八阵');
          if (j.card.color === 'red') {
            this.log(`${armor && armor.name === 'bagua' ? '【八卦阵】' : '【八阵】'}判定为红色，视为 ${this.nameOf(target)} 使用【闪】`, 'skill');
            this.pushResponseCard(target, 'shan');
            await this.hujiaReward(target);
            if (target.skills.includes('leiji')) await this.skillLeiji(target);
            return true;
          }
        }
      }
      // 护驾（主公技）
      if (!target.flags.noSkills && (target.skills.includes('hujia') || target.skills.includes('j_hujia')) && target.role === 'lord') {
        const helpers = this.alivePlayers.filter((q) => q.seat !== target.seat && q.kingdom === '魏');
        for (const h of helpers) {
          const card = await this.askForNamedCard(h, 'shan', `主公 ${this.nameOf(target)} 需要【闪】，是否替其打出？`);
          if (card) { this.pushResponseCard(h, 'shan'); this.log(`${this.nameOf(h)} 响应【护驾】打出【闪】`, 'skill'); await this.hujiaReward(h); return true; }
        }
      }
      const opts = this.shanOptions(target);
      if (!opts.length) return false;
      const res = await this.ask(target, { type: 'response', player: target, need: 'shan', options: opts, reason: ctx.reason || '请使用一张【闪】', card: ctx.card, sourceSeat: ctx.source ? ctx.source.seat : null });
      if (!res || res.cardId == null) return false;
      const playedCard = this.findCard(target, res.cardId);
      const fromHand = !!(playedCard && target.hand.some((c) => c.id === playedCard.id));
      const ok = this.commitResponse(target, res);
      if (ok) this.pushResponseCard(target, 'shan');
      if (ok && fromHand) await this.yajiaoTrigger(target, playedCard);
      if (ok) await this.hujiaReward(target);
      if (ok && res.skill && /longdan/.test(res.skill)) await this.chongzhenGain(target, ctx.source);
      if (ok && target.skills.includes('leiji')) await this.skillLeiji(target);
      // 聚众（农民）：队友实际打出【闪】生效后，可弃同名【闪】弃置一名角色一张牌
      if (ok && this.ddzMode && playedCard && playedCard.name === 'shan') await this.juzhongAfterShan(target);
      return ok;
    },

    shanOptions(p) {
      if (p.flags && p.flags.noHand) return []; // 义绝（黑）：不能使用或打出手牌
      const opts = [];
      for (const c of p.hand) {
        if (c.name === 'shan') opts.push({ cardId: c.id, as: 'shan', skill: null });
        else if (c.name === 'sha' && (p.skills.includes('longdan') || p.skills.includes('j_longdan'))) opts.push({ cardId: c.id, as: 'shan', skill: p.skills.includes('j_longdan') ? 'j_longdan' : 'longdan' });
        else if (c.color === 'black' && p.skills.includes('qingguo')) opts.push({ cardId: c.id, as: 'shan', skill: 'qingguo' });
        else if (this.ddzFierce && c.name === 'tao') opts.push({ cardId: c.id, as: 'shan', skill: null });
      }
      return opts;
    },

    // ================= 响应：杀 =================
    async askForSha(p, ctx) {
      if (!p.alive) return null;
      // 激将：主公需要【杀】时可令蜀势力角色代打
      if (!p.flags.noSkills && p.skills.includes('jijiang') && p.role === 'lord') {
        for (const a of this.alivePlayers) {
          if (a.seat === p.seat || a.kingdom !== '蜀') continue;
          const ar = await this.ask(a, { type: 'response', player: a, need: 'sha', options: this.shaOptions(a), reason: `主公 ${this.nameOf(p)} 发动【激将】，是否替其打出【杀】？` });
          const pc = ar && ar.cardId != null ? this.findCard(a, ar.cardId) : null;
          if (ar && ar.cardId != null && this.commitResponse(a, ar)) {
            this.pushResponseCard(a, 'sha');
            this.log(`${this.nameOf(a)} 响应【激将】打出【杀】`, 'skill');
            await this.jijiangReward(a);
            if (pc) await this.yajiaoTrigger(a, pc);
            await this.hujiaReward(a);
            return { cards: [], skill: 'jijiang' };
          }
        }
      }
      const opts = this.shaOptions(p);
      if (!opts.length) return null;
      const res = await this.ask(p, { type: 'response', player: p, need: 'sha', options: opts, reason: ctx.reason || '请打出一张【杀】', mustUse: ctx.mustUse });
      if (!res || res.cardId == null) return null;
      // 先取实际打出的牌名/属性，再 commitResponse 移牌
      const played = this.findCard(p, res.cardId);
      const asName = res.as || (played && played.name) || 'sha';
      const nature = asName === 'huosha' ? 'fire' : (asName === 'leisha' ? 'thunder' : 'normal');
      const fromHand = !!(played && p.hand.some((c) => c.id === played.id));
      const ok = this.commitResponse(p, res);
      if (ok) this.pushResponseCard(p, asName);
      if (ok) await this.jijiangReward(p);
      if (ok && fromHand) await this.yajiaoTrigger(p, played);
      if (ok) await this.hujiaReward(p);
      if (ok && res.skill && /longdan/.test(res.skill) && ctx.opponent != null) await this.chongzhenGain(p, this.players[ctx.opponent]);
      return ok ? { cards: [res.cardId], skill: res.skill, name: asName, nature } : null;
    },

    shaOptions(p) {
      if (p.flags && p.flags.noHand) return []; // 义绝（黑）：不能使用或打出手牌
      const opts = [];
      // 筹伐（司马昭）：与展示牌类型不同的手牌视为【杀】
      if (p.marks && p.marks.choufaType) {
        for (const c of p.hand) {
          const tp = (CARDS[c.name] || {}).type;
          if (tp && tp !== p.marks.choufaType) opts.push({ cardId: c.id, as: 'sha', skill: 'j_choufa' });
        }
      }
      const all = [...p.hand, ...Object.values(p.equips).filter(Boolean)];
      for (const c of all) {
        if (['sha', 'huosha', 'leisha'].includes(c.name)) opts.push({ cardId: c.id, as: c.name, skill: null });
        else if (c.name === 'shan' && (p.skills.includes('longdan') || p.skills.includes('j_longdan'))) opts.push({ cardId: c.id, as: 'sha', skill: p.skills.includes('j_longdan') ? 'j_longdan' : 'longdan' });
        else if (c.color === 'red' && (p.skills.includes('wusheng') || p.skills.includes('j_wusheng'))) opts.push({ cardId: c.id, as: 'sha', skill: p.skills.includes('j_wusheng') ? 'j_wusheng' : 'wusheng' });
        else if (this.ddzFierce && c.name === 'tao') opts.push({ cardId: c.id, as: 'sha', skill: null });
      }
      return opts;
    },

    commitResponse(p, res) {
      const c = this.findCard(p, res.cardId);
      if (!c) return false;
      this.removeAnyCard(p, c.id);
      this.toDiscard([c]);
      this.afterLoseCards(p, [c]);
      if (res.as === 'sha' || ['sha', 'huosha', 'leisha'].includes(c.name)) p.slashCount = (p.slashCount || 0) + 1;
      this.log(`${this.nameOf(p)} 打出 ${this.cardText(c)}${res.skill ? '（' + (D.SKILLS[res.skill] ? D.SKILLS[res.skill].name : res.skill) + '）' : ''}`, 'respond');
      this.emit();
      return true;
    },

    async askForNamedCard(p, need, reason) {
      const opts = need === 'shan' ? this.shanOptions(p) : this.shaOptions(p);
      if (!opts.length) return null;
      const res = await this.ask(p, { type: 'response', player: p, need, options: opts, reason });
      if (!res || res.cardId == null) return null;
      return this.commitResponse(p, res) ? res : null;
    },

    // ================= 响应：桃（濒死） =================
    async askForPeach(healer, dying) {
      if (!healer.alive) return null;
      if (healer.flags && healer.flags.noHand) return null; // 义绝（黑）：不能使用或打出手牌
      const cur = this.players[this.currentSeat];
      if (cur && cur.alive && cur.skills.includes('wansha') && healer.seat !== dying.seat && healer.seat !== cur.seat) {
        this.log(`【完杀】：${this.nameOf(healer)} 不能使用【桃】`, 'info');
        return null;
      }
      const opts = [];
      const all = [...healer.hand, ...Object.values(healer.equips).filter(Boolean)];
      for (const c of all) {
        if (this.ddzFierce && c.name === 'tao') continue; // 鏖战：桃不能当【桃】
        if (c.name === 'tao') opts.push({ cardId: c.id, as: 'tao', skill: null });
        else if (c.name === 'jiu' && (healer.seat === dying.seat || healer.skills.includes('j_longdan'))) opts.push({ cardId: c.id, as: 'tao', skill: healer.skills.includes('j_longdan') ? 'j_longdan' : 'jiu' });
        else if (healer.skills.includes('jijiu') && c.color === 'red' && healer.seat !== this.currentSeat) opts.push({ cardId: c.id, as: 'tao', skill: 'jijiu' });
      }
      if (!opts.length) return null;
      const res = await this.ask(healer, { type: 'response', player: healer, need: 'tao', options: opts, reason: `${this.nameOf(dying)} 濒死，是否使用【桃】？`, dyingSeat: dying.seat });
      if (!res || res.cardId == null) return null;
      const played = this.findCard(healer, res.cardId);
      const fromHand = !!(played && healer.hand.some((c) => c.id === played.id));
      const ok = this.commitResponse(healer, res);
      if (ok) this.pushResponseCard(healer, played ? played.name : 'tao');
      if (ok && fromHand) await this.yajiaoTrigger(healer, played);
      return ok ? { cardId: res.cardId, usedName: played ? played.name : null } : null;
    },

    // 涯角（赵云 Po）：回合外使用/打出手牌时，展示牌堆顶并比对类型
    async yajiaoTrigger(p, card) {
      if (!p || !p.alive || !p.skills || !p.skills.includes('j_yajiao')) return;
      if (this.currentSeat === p.seat) return; // 仅回合外
      if (!card) return;
      const r = await this.askOption(p, '【涯角】：是否展示牌堆顶一张牌？', ['yes', 'no'], ['发动', '放弃']);
      if (r !== 'yes') return;
      if (this.deck.length === 0) this.reshuffle();
      const top = this.deck.pop();
      if (!top) return;
      this.log(`${this.nameOf(p)} 发动【涯角】展示牌堆顶 ${this.cardText(top)}`, 'skill');
      this.emit();
      const t1 = (CARDS[card.name] || {}).type;
      const t2 = (CARDS[top.name] || {}).type;
      if (t1 && t1 === t2) {
        const cands = this.alivePlayers.map((q) => q.seat);
        const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: '涯角：选择获得展示牌的角色', candidates: cands, min: 1, max: 1 });
        const t = ts && this.players[ts[0]];
        if (t && t.alive) {
          t.hand.push(top);
          this.afterCardGain(t, [top]);
          this.log(`${this.nameOf(t)} 获得【涯角】展示的 ${this.cardText(top)}`, 'skill');
        } else this.deck.push(top);
      } else {
        const cands = this.alivePlayers.filter((q) => q.seat !== p.seat && this.allCardsOf(q).length && this.inAttackRange(q, p)).map((q) => q.seat);
        if (!cands.length) { this.deck.push(top); return; }
        const ts = await this.ask(p, { type: 'chooseTargets', player: p, reason: '涯角：选择攻击范围内包含你的角色', candidates: cands, min: 1, max: 1 });
        const q = ts && this.players[ts[0]];
        if (q && q.alive) {
          const c = await this.pickCardFrom(q, p, { zones: ['hand', 'equip', 'judge'], reason: '涯角：弃置其一张牌' });
          if (c) { this.toDiscard([c]); await this.afterLoseCards(q, [c]); this.log(`${this.nameOf(p)} 发动【涯角】弃置 ${this.nameOf(q)} 的 ${this.cardText(c)}`, 'skill'); }
        }
        this.deck.push(top);
      }
      this.emit();
    },

    // ================= 小工具 =================
    async askOption(p, reason, ids, labels) {
      return this.ask(p, {
        type: 'chooseOption', player: p, reason,
        options: ids.map((id, i) => ({ id, label: labels ? labels[i] : id })),
      });
    },
  });

  function q_find(q, id) { return q.hand.find((c) => c.id === id); }

  global.SGS.CONVERSIONS = CONVERSIONS;
})(typeof window !== 'undefined' ? window : globalThis);
