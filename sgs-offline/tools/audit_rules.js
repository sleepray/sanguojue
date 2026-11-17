/* 只读审计脚本：受控场景验证技能/卡牌实际行为，不改引擎 */
const path = require('path');
const { spawnSync } = require('child_process');
const base = path.join(__dirname, '..', 'js');
require(path.join(base, 'skilldesc.js'));
require(path.join(base, 'data.js'));
require(path.join(base, 'game.js'));
require(path.join(base, 'cards.js'));
require(path.join(base, 'skills.js'));
require(path.join(base, 'ai.js'));
const SGS = globalThis.SGS, D = globalThis.SGS_DATA;
let seq = 1000;
const C = (name, suit, rank) => {
  const def = D.CARDS[name];
  return { id: seq++, name, suit, rank, type: def.type, subtype: def.subtype || null, range: def.range || 0, color: D.SUITS[suit].color, nature: def.nature || 'normal' };
};
function P(spec, seat) {
  const maxHp = spec.maxHp == null ? 4 : spec.maxHp;
  return {
    seat, name: spec.name || ('P' + seat), role: spec.role || 'loyalist', isHuman: false,
    general: { id: 999 + seat, name: spec.name || ('P' + seat), kingdom: spec.kingdom || '群', gender: spec.gender || 'male', hp: maxHp, skills: spec.skills || [], pack: 'x' },
    kingdom: spec.kingdom || '群', gender: spec.gender || 'male',
    hp: spec.hp == null ? maxHp : spec.hp, maxHp, alive: true,
    hand: [], equips: { weapon: null, armor: null, offhorse: null, defhorse: null }, judges: [],
    flags: {}, used: {}, once: {}, chained: false, flipped: false, marks: {}, skip: {},
    revealed: false, givenRende: 0, slashCount: 0, skills: (spec.skills || []).slice(),
  };
}
function game(specs, opt = {}) {
  const g = new SGS.Game({ mode: opt.mode || '8p', seed: 42, humanSeat: -1, onUpdate() {} });
  g.players = specs.map((s, i) => P(s, i));
  g.players.forEach((p) => { if (p.role === 'lord') g.lordSeat = p.seat; });
  g.currentSeat = 0; g.deck = []; g.discardPile = []; g.table = []; g.logs = [];
  g.pause = async () => {}; g.checkWin = () => {};
  g._asks = []; g._damages = [];
  g.handler = async () => null;
  g.ask = async (p, req) => {
    req.player = p; req._askerAlive = p.alive; g._asks.push(req);
    g.pendingRequest = req; // 与 Game.ask 一致，便于断言“人类收到的 pending request”
    let r;
    try {
      r = await g.handler(p, req);
    } finally {
      g.pendingRequest = null;
    }
    if (req.type === 'chooseHiddenCard' && (r == null || r === false)) r = 0;
    if (req.type === 'chooseCards' && Array.isArray(r)) {
      const pool = (req.cards || []).slice();
      r = r.map((x) => (x && typeof x === 'object') ? x : (pool.find((c) => c.id === x) || g.allCardsOf(p).find((c) => c.id === x) || null)).filter(Boolean);
    }
    return r;
  };
  const od = g.damage.bind(g);
  g.damage = async (o) => { g._damages.push({ source: o.source && o.source.name, target: o.target && o.target.name, amount: o.amount }); return od(o); };
  g.rng = () => 0; // 确定性
  return g;
}
const results = [];
const skips = [];
function t(id, name, cond, detail) { results.push({ id, name, pass: !!cond, detail }); console.log((cond ? 'PASS ' : 'FAIL ') + id + ' ' + name + ' :: ' + detail); }
function skip(id, name, detail) { skips.push({ id, name, detail }); console.log('SKIP ' + id + ' ' + name + ' :: ' + detail); }
const names = (p) => p.hand.map((c) => c.name + '/' + c.suit + c.rank).join(',');

(async () => {
  // T1 再起：红桃应弃、非红桃应获得
  {
    const g = game([{ name: '孟获', skills: ['zaiqi'], hp: 1, maxHp: 4 }]);
    g.deck = [C('shan', 'diamond', 3), C('tao', 'heart', 2), C('tao', 'heart', 1)];
    g.handler = async (p, req) => req.type === 'chooseOption' ? 'yes' : null;
    await g.skillDrawPhase(g.players[0]);
    t('T1', '再起红桃处置', g.players[0].hand.length === 1 && g.players[0].hand[0].suit !== 'heart' && g.players[0].hp === 3, '官方应弃红桃、获得非红桃；实际手牌=' + (names(g.players[0]) || '空') + '，hp=' + g.players[0].hp);
  }
  // T2 行殇：曹丕应获得死者所有牌
  {
    const g = game([{ name: '曹丕', skills: ['xingshang'], role: 'lord' }, { name: '死者', skills: [], role: 'rebel' }]);
    const deadCard = C('sha', 'spade', 7);
    g.players[1].hand = [deadCard];
    g.handler = async (p, req) => (/行殇/.test(req.reason || '') && req.type === 'chooseOption') ? 'yes' : null;
    await g.kill(g.players[1], g.players[0]);
    const got = g.players[0].hand.some((c) => c.id === deadCard.id);
    t('T2', '行殇触发者', got, '其他角色死亡时曹丕应获得其牌；实际是否拿到死者那张=' + got + '，曹丕手牌=' + g.players[0].hand.length);
  }
  // T3 狂骨：魏延造成伤害应回复；受伤不应回复
  {
    const g = game([{ name: '魏延', skills: ['kuanggu'], hp: 2, maxHp: 4 }, { name: '甲', skills: [] }]);
    await g.damage({ source: g.players[0], target: g.players[1], amount: 1 });
    const afterDeal = g.players[0].hp;
    g.players[0].hp = 2; g.players[1].hp = 4;
    await g.damage({ source: g.players[1], target: g.players[0], amount: 1 });
    const afterTaken = g.players[0].hp;
    t('T3', '狂骨触发方向', afterDeal === 3 && afterTaken === 1, '官方：魏延造成伤害才回血。实际造成伤害后hp=' + afterDeal + '（应3），受伤后hp=' + afterTaken + '（应1）');
  }
  // T4 不屈：周泰0血不应死亡
  {
    const g = game([{ name: '周泰', skills: ['buqu'], hp: 1, maxHp: 4 }, { name: '甲', skills: [] }]);
    g.deck = [C('sha', 'spade', 1), C('shan', 'heart', 2), C('sha', 'club', 3)];
    g.handler = async (p, req) => null;
    await g.damage({ source: g.players[1], target: g.players[0], amount: 1 });
    t('T4', '不屈挡死', g.players[0].alive === true, '官方：不屈判定成功则不死亡（hp≤0但存活）。实际 alive=' + g.players[0].alive + '，hp=' + g.players[0].hp);
  }
  // T5 悲歌：任意角色受杀伤害都应可触发
  {
    const g = game([{ name: '蔡文姬', skills: ['beige'] }, { name: '受害者', skills: [] }, { name: '凶手', skills: [] }]);
    g.players[0].hand = [C('shan', 'heart', 2)];
    await g.damage({ source: g.players[2], target: g.players[1], amount: 1, card: C('sha', 'spade', 7) });
    const asked = g._asks.some((r) => /悲歌/.test(r.reason || ''));
    t('T5', '悲歌触发范围', asked, '官方：一名角色受到杀伤害即可发动。实际是否询问悲歌=' + asked);
  }
  // T6 放逐：X=已损失体力，目标应为其他角色
  {
    // 注意：需为“未致死”的受伤（致命伤害会先进入濒死/阵亡，不再触发受伤后技能）
    const g = game([{ name: '曹丕', skills: ['fangzhu'], hp: 2, maxHp: 4 }, { name: '甲', skills: [] }]);
    for (let i = 0; i < 8; i++) g.deck.push(C('sha', 'spade', 7));
    let targetCands = null;
    g.handler = async (p, req) => {
      if (/放逐/.test(req.reason || '') && req.type === 'chooseOption') return 'yes';
      if (req.type === 'chooseTargets' && /放逐/.test(req.reason || '')) { targetCands = req.candidates; return [1]; }
      return null;
    };
    const before = g.players[1].hand.length;
    await g.damage({ source: null, target: g.players[0], amount: 1 });
    const drawn = g.players[1].hand.length - before;
    t('T6', '放逐X与目标', drawn === 3 && targetCands && targetCands.indexOf(0) < 0, '官方：X=已损失体力(此处3)，目标为一名其他角色。实际摸=' + drawn + '，候选=' + JSON.stringify(targetCands));
  }
  // T7 好施：摸牌阶段才发动，play 阶段设置后新回合是否保留
  {
    const g = game([{ name: '鲁肃', skills: ['haoshi'] }]);
    const acts = g.buildPlayActions(g.players[0]);
    const act = acts.find((a) => a.skill === 'haoshi');
    let hasAct = !!act;
    if (act) await g.executeAction(g.players[0], act);
    const flagInPlay = !!g.players[0].flags.haoshi;
    g.players[0].flags = {}; // 新回合 takeTurn 会重置 flags
    const before = g.players[0].hand.length;
    g.deck = [C('sha', 'spade', 7), C('sha', 'club', 8), C('sha', 'heart', 9), C('sha', 'diamond', 10)];
    g.handler = async () => null;
    const handled = await g.skillDrawPhase(g.players[0]);
    const drawn = g.players[0].hand.length - before;
    t('T7', '好施时机', !hasAct && flagInPlay === false, '官方：摸牌阶段发动。实际play阶段动作=' + hasAct + '，flag=' + flagInPlay + '，新回合摸牌=' + drawn + '，handled=' + handled);
  }
  // T8 天义：赢后次数+1/无距离，输后禁杀
  {
    const g = game([{ name: '太史慈', skills: ['tianyi'] }, { name: '甲', skills: [] }]);
    const p = g.players[0], t0 = g.players[1];
    p.hand = [C('sha', 'spade', 10)]; t0.hand = [C('sha', 'heart', 5)];
    g.handler = async (pl, req) => req.type === 'chooseCards' ? [req.cards[0].id] : null;
    await g.useSkillAction(p, { skill: 'tianyi', cards: [], targets: [1] });
    const winFlag = p.flags.tianyiWin;
    p.slashCount = 1;
    const canAfterWin = g.canUseSlash(p);
    p.flags = {}; p.slashCount = 0; p.hand = [C('sha', 'spade', 5)]; t0.hand = [C('sha', 'heart', 10)];
    await g.useSkillAction(p, { skill: 'tianyi', cards: [], targets: [1] });
    const loseFlag = p.flags.tianyiLose;
    const canAfterLose = g.canUseSlash(p);
    t('T8', '天义胜负效果', winFlag === true && canAfterWin === true && loseFlag === true && canAfterLose === false,
      '赢后应可再杀：canUseSlash=' + canAfterWin + '（应true）；输后应禁杀：canUseSlash=' + canAfterLose + '（应false）');
  }
  // T9 屯田：田应减距离；仅回合外触发
  {
    const g = game([{ name: '邓艾', skills: ['tuntian'] }, { name: '甲', skills: [] }, { name: '乙', skills: [] }, { name: '丙', skills: [] }, { name: '丁', skills: [] }]);
    const d0 = g.distance(g.players[0], g.players[3]);
    g.players[0].marks.tian = 3;
    const d3 = g.distance(g.players[0], g.players[3]);
    g.currentSeat = 0; // 邓艾自己的回合
    g.deck = [C('sha', 'spade', 7)];
    const before = g.players[0].marks.tian;
    await g.afterLoseCardsHook(g.players[0], [C('shan', 'heart', 2)]);
    const inTurnGain = g.players[0].marks.tian - before;
    t('T9', '屯田距离与回合外', d3 === Math.max(1, d0 - 3) && inTurnGain === 0, '3田后距离应2→1（实际' + d0 + '→' + d3 + '）；自己回合失去牌不应得田（实际+' + inTurnGain + '）');
  }
  // T10 丈八蛇矛
  {
    const g = game([{ name: '张飞', skills: [] }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    p.equips.weapon = C('zhangba', 'spade', 12);
    p.hand = [C('sha', 'spade', 7), C('sha', 'club', 8)];
    const acts = g.buildPlayActions(p);
    const act = acts.find((a) => a.skill === 'zhangba');
    if (act) await g.executeAction(p, Object.assign({}, act, { cards: p.hand.map((c) => c.id), targets: [1] }));
    const unimplemented = g.logs.some((l) => /暂未实现/.test(l.text));
    t('T10', '丈八蛇矛转换', act && !unimplemented, '官方：两张手牌当杀。实际动作=' + !!act + '，日志未实现=' + unimplemented + '，目标hp=' + g.players[1].hp);
  }
  // T11 酒池花色
  {
    const conv = SGS.CONVERSIONS.find((c) => c.skill === 'jiuchi');
    const spade = conv.test(C('sha', 'spade', 5)), club = conv.test(C('sha', 'club', 5));
    t('T11', '酒池花色', spade === true && club === false, '官方：黑桃手牌当酒。实际黑桃=' + spade + '，梅花=' + club);
  }
  // T12 暴虐判定花色
  {
    const g = game([{ name: '董卓', skills: ['baonue'], role: 'lord', kingdom: '群', maxHp: 8, hp: 3 }, { name: '群甲', skills: [], kingdom: '群' }, { name: '乙', skills: [] }]);
    g.deck = [C('sha', 'club', 7)];
    g.handler = async (p, req) => { if (/暴虐/.test(req.reason || '')) return 'yes'; return null; };
    await g.damage({ source: g.players[1], target: g.players[2], amount: 1 });
    t('T12', '暴虐判定花色', g.players[0].hp === 3, '官方：判定为黑桃才回复。梅花判定后实际hp=' + g.players[0].hp + '（应3）');
  }
  // T13 断粮距离2
  {
    const g = game([{ name: '徐晃', skills: ['duanliang'] }, { name: '甲' }, { name: '乙' }, { name: '丙' }, { name: '丁' }]);
    const tg = g.legalTargetsFor(g.players[0], 'bingliang', null, null);
    t('T13', '断粮距离2', tg.indexOf(2) >= 0 || tg.indexOf(3) >= 0, '官方：可对距离2角色用兵粮。实际可选=' + JSON.stringify(tg));
  }
  // T14 奇才兵粮无距离
  {
    const g = game([{ name: '黄月英', skills: ['jizhi', 'qicai'] }, { name: '甲' }, { name: '乙' }, { name: '丙' }, { name: '丁' }]);
    const tg = g.legalTargetsFor(g.players[0], 'bingliang', null, null);
    t('T14', '奇才兵粮距离', tg.indexOf(2) >= 0 || tg.indexOf(3) >= 0, '官方：奇才令锦囊无距离限制。实际可选=' + JSON.stringify(tg));
  }
  // T15 裸衣决斗伤害
  {
    const g = game([{ name: '许褚', skills: ['luoyi'] }, { name: '甲', skills: [] }]);
    g.players[0].damageBonus = 1;
    g.handler = async (p, req) => req.type === 'response' ? null : null;
    await g.resolveDuel(g.players[0], { id: -9, name: 'juedou', type: 'trick', suit: 'none', rank: 0, color: 'none', cards: [] }, g.players[1]);
    const d = g._damages[g._damages.length - 1];
    t('T15', '裸衣决斗+1', d && d.amount === 2, '官方：裸衣本回合杀/决斗伤害+1。实际决斗伤害=' + (d && d.amount));
  }
  // T16 白银狮子失去时回血
  {
    const g = game([{ name: '甲', skills: [], hp: 2, maxHp: 4 }]);
    const p = g.players[0];
    const armor = C('baiyinshizi', 'club', 1);
    p.equips.armor = armor;
    p.equips.armor = null; g.toDiscard([armor]); g.afterLoseCards(p, [armor]);
    const afterLose = p.hp;
    const armor2 = C('baiyinshizi', 'club', 1); p.equips.armor = armor2;
    g.installEquip(p, C('bagua', 'spade', 2));
    t('T16', '白银狮子失去回血', afterLose === 3, '官方：失去此牌回复1点。实际被弃置后hp=' + afterLose + '（应3）；替换装备时才回血=' + p.hp);
  }
  // T17 洛神判定可被鬼才改判
  {
    const g = game([{ name: '甄姬', skills: ['luoshen'] }, { name: '司马懿', skills: ['guicai'] }]);
    g.players[1].hand = [C('sha', 'club', 3)];
    g.deck = [C('sha', 'spade', 7), C('sha', 'heart', 9)];
    g.handler = async (p, req) => { if (req.type === 'chooseOption') return 'no'; return null; };
    await g.skillLuoshen(g.players[0]);
    const guicaiAsked = g._asks.some((r) => /鬼才/.test(r.reason || ''));
    t('T17', '洛神判定改判', guicaiAsked, '官方：洛神是判定，鬼才可改。实际是否询问鬼才=' + guicaiAsked);
  }
  // T18 延时锦囊生效时可无懈
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g.players[1].hand = [C('wuxie', 'spade', 11)];
    const lebu = C('lebu', 'spade', 6); lebu.type = 'delayed';
    g.players[0].judges = [lebu];
    g.deck = [C('sha', 'spade', 7)];
    g.handler = async () => null;
    await g.phaseJudge(g.players[0]);
    const wuxieAsked = g._asks.some((r) => r.need === 'wuxie');
    t('T18', '延时锦囊无懈窗口', wuxieAsked, '官方：延时锦囊生效前可用无懈。实际是否询问无懈=' + wuxieAsked);
  }
  // T19 神速阶段与模式
  {
    const g = game([{ name: '夏侯渊', skills: ['shensu'] }, { name: '甲', skills: [] }]);
    const acts = g.buildPlayActions(g.players[0]);
    const inPlay = !!acts.find((a) => a.skill === 'shensu');
    const g2 = game([{ name: '夏侯渊', skills: ['shensu'] }, { name: '甲', skills: [] }]);
    g2.players[0].hand = [C('sha', 'spade', 7)];
    g2.players[0].equips.weapon = C('qinglong', 'spade', 5);
    g2.deck = [C('sha', 'spade', 7), C('sha', 'club', 8)];
    let opts = null;
    g2.handler = async (p, req) => { if (req.type === 'chooseOption') { opts = opts || req.options.map((o) => o.id); return 'no'; } return null; };
    await g2.skillPhaseStart(g2.players[0]);
    t('T19', '神速时机与模式', inPlay === false, '官方：神速只在判定/出牌阶段开始触发，且有模式2（弃装备）。实际play阶段出现=' + inPlay + '，准备阶段选项=' + JSON.stringify(opts));
  }
  // T20 涅槃限定技
  {
    const g = game([{ name: '庞统', skills: ['niepan'], hp: 1, maxHp: 4 }]);
    g.handler = async (p, req) => /涅槃/.test(req.reason || '') ? 'yes' : null;
    g.players[0].hp = 0;
    await g.dying(g.players[0], null);
    const first = g.players[0].hp;
    g.players[0].used = {}; // 新回合 takeTurn 清空 used
    g.players[0].hp = 0;
    await g.dying(g.players[0], null);
    const second = g.players[0].hp;
    t('T20', '涅槃限定一次', first === 3 && second === 0, '官方：限定技全场一次。实际第一次复活hp=' + first + '，清空used后第二次hp=' + second + '（应0=不可再发动）');
  }
  // T21 红颜：黑桃判定视为红桃
  {
    const g = game([{ name: '小乔', skills: ['tianxiang', 'hongyan'] }, { name: '甲', skills: [] }]);
    const lebu = C('lebu', 'spade', 6); lebu.type = 'delayed';
    g.players[0].judges = [lebu];
    g.deck = [C('sha', 'spade', 5)];
    g.handler = async () => null;
    await g.phaseJudge(g.players[0]);
    t('T21', '红颜改判花色', g.players[0].skip.play !== true, '官方：小乔黑桃牌视为红桃。黑桃判定后实际skip.play=' + g.players[0].skip.play + '（应false）');
  }
  // T22 克己：响应打出杀后不可发动
  {
    const g = game([{ name: '吕蒙', skills: ['keji'] }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    p.hand = [C('sha', 'spade', 7), C('sha', 'club', 8), C('sha', 'heart', 9), C('sha', 'diamond', 10), C('sha', 'spade', 11), C('sha', 'club', 12)];
    g.handler = async (pl, req) => { if (req.type === 'response' && req.options && req.options.length) return { cardId: req.options[0].cardId }; return 'no'; };
    await g.askForSha(p, { reason: 'test' });
    const slashCount = p.slashCount;
    let kejiAsked = false;
    g.handler = async (pl, req) => { if (/克己/.test(req.reason || '')) { kejiAsked = true; return 'yes'; } return null; };
    await g.phaseDiscard(p);
    t('T22', '克己响应杀', slashCount === 1 && kejiAsked === false, '官方：使用或打出过杀即不可克己。实际打出杀后slashCount=' + slashCount + '（应1），仍询问克己=' + kejiAsked + '（应false）');
  }
  // T23 连营只应因失去手牌
  {
    const g = game([{ name: '陆逊', skills: ['lianying'] }]);
    g.deck = [C('sha', 'spade', 7), C('sha', 'club', 8)];
    const p = g.players[0];
    p.hand = []; const armor = C('bagua', 'spade', 2); p.equips.armor = armor; p.equips.armor = null;
    await g.afterLoseCards(p, [armor]);
    t('T23', '连营触发条件', p.hand.length === 0, '官方：失去最后的手牌才摸。实际失去装备后手牌=' + p.hand.length + '（应0）');
  }
  // T24 急救/武圣 装备区红牌
  {
    const g = game([{ name: '华佗', skills: ['jijiu'], hp: 3, maxHp: 3 }, { name: '甲', skills: [] }]);
    g.players[0].equips.weapon = C('sha', 'heart', 7);
    g.currentSeat = 1;
    g.handler = async (p, req) => {
      if (req.type === 'response' && req.need === 'tao' && req.options && req.options.length) return { cardId: req.options[0].cardId, as: 'tao', skill: req.options[0].skill };
      return null;
    };
    const r = await g.askForPeach(g.players[0], g.players[1]);
    const g2 = game([{ name: '关羽', skills: ['wusheng'] }, { name: '甲', skills: [] }]);
    g2.players[0].equips.weapon = C('sha', 'diamond', 6);
    const shaOpts = g2.shaOptions(g2.players[0]);
    t('T24', '急救/武圣装备区', r !== null && shaOpts.length > 0, '官方：红色牌/红色装备可转化。实际急救可用=' + (r !== null) + '，武圣响应选项=' + shaOpts.length);
  }
  // T25 挑衅方向
  {
    const g = game([{ name: '姜维', skills: ['tiaoxin'] }, { name: '甲' }, { name: '乙', skills: [] }, { name: '丙' }, { name: '丁' }]);
    g.players[2].equips.weapon = C('qilin', 'heart', 5); // 攻击范围5
    const acts = g.buildPlayActions(g.players[0]);
    const act = acts.find((a) => a.skill === 'tiaoxin');
    t('T25', '挑衅目标方向', act && act.targetCandidates.indexOf(2) >= 0, '官方：目标攻击范围包含姜维即可。实际候选=' + (act ? JSON.stringify(act.targetCandidates) : 'null'));
  }
  // T26 制霸方向
  {
    const g = game([{ name: '孙策', skills: ['jiang', 'hunzi', 'zhiba'] }, { name: '张飞', skills: [] }]);
    const acts = g.buildPlayActions(g.players[0]);
    const act = acts.find((a) => a.skill === 'zhiba');
    t('T26', '制霸发动方', !act, '官方：由其他吴势力角色发起，孙策不应有主动动作。实际动作=' + (act ? JSON.stringify(act.targetCandidates) : 'null'));
  }
  // T27 巧变移动牌
  {
    const g = game([{ name: '张郃', skills: ['qiaobian'] }, { name: '甲', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    const armor = C('bagua', 'spade', 2);
    q.equips.armor = armor;
    p.hand = [C('sha', 'spade', 7)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /巧变/.test(req.reason || '')) return 'play';
      if (req.type === 'chooseTargets') return [1];
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'armor' };
      return null;
    };
    await g.useSkillAction(p, { skill: 'qiaobian', cards: [p.hand[0].id], targets: [] });
    const inHand = p.hand.some((c) => c.id === armor.id);
    const inDiscard = g.discardPile.some((c) => c.id === armor.id);
    const onField = q.equips.armor && q.equips.armor.id === armor.id;
    t('T27', '巧变移动牌归属', onField || inHand || inDiscard, '官方：移动场上一张牌到另一角色区域。实际：原区=' + !!onField + '，张郃手牌=' + inHand + '，弃牌堆=' + inDiscard + '（三处皆无=牌凭空消失）');
  }
  // T28 缔盟费用
  {
    const g = game([{ name: '鲁肃', skills: ['haoshi', 'dimeng'] }, { name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0], a = g.players[1], b = g.players[2];
    p.hand = [C('sha', 'spade', 7)];
    for (let i = 0; i < 4; i++) a.hand.push(C('shan', 'heart', 2));
    b.hand = [C('tao', 'heart', 3)];
    g.handler = async (pl, req) => { if (req.type === 'chooseCards') return [req.cards[0].id]; return null; };
    await g.useSkillAction(p, { skill: 'dimeng', cards: [], targets: [1, 2] });
    const swapped = a.hand.length === 1 && b.hand.length === 4;
    t('T28', '缔盟费用钳制', swapped === false, '官方：须弃X张(X=手牌差3)，不足则不能发动。实际仅1张就完成交换=' + swapped);
  }
  // T29 乱武最近目标按距离
  {
    const g = game([{ name: '贾诩', skills: ['wansha', 'luanwu', 'weimu'] }, { name: '甲', skills: [] }, { name: '乙' }, { name: '丙' }, { name: '丁' }]);
    g.players[3].equips.defhorse = C('dilu', 'club', 5); // seat3 与 seat2 距离+1
    const nearest = g.nearestPlayers(g.players[2]).map((q) => q.seat);
    const byDist = g.alivePlayers.filter((q) => q.seat !== 2).map((q) => ({ s: q.seat, d: g.distance(g.players[2], q) })).sort((x, y) => x.d - y.d);
    const minSeats = byDist.filter((x) => x.d === byDist[0].d).map((x) => x.s);
    const chosen = nearest[0];
    t('T29', '乱武最近角色', minSeats.indexOf(chosen) >= 0, '官方：对距离最近者出杀。实际实现固定选nearest[0]=' + chosen + '，真正最近=' + JSON.stringify(minSeats) + '（nearest=' + JSON.stringify(nearest) + '）');
  }
  // T30 铁索传导
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g.players[0].chained = true; g.players[1].chained = true;
    await g.damage({ source: null, target: g.players[0], amount: 1, nature: 'fire' });
    t('T30', '铁索属性传导', g.players[1].hp === 3, '官方：横置角色同受属性伤害。实际乙hp=' + g.players[1].hp + '（应3）');
  }
  // T31 藤甲/白银
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g.players[0].equips.armor = C('tengjia', 'spade', 2);
    await g.damage({ source: g.players[1], target: g.players[0], amount: 1, nature: 'fire' });
    const tengjiaHp = g.players[0].hp;
    const g2 = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g2.players[0].equips.armor = C('baiyinshizi', 'club', 1);
    await g2.damage({ source: g2.players[1], target: g2.players[0], amount: 3, nature: 'normal' });
    t('T31', '藤甲火伤+1/白银减伤', tengjiaHp === 2 && g2.players[0].hp === 3, '藤甲应4-2=2（实际' + tengjiaHp + '）；白银应4-1=3（实际' + g2.players[0].hp + '）');
  }
  // T32 酒/古锭刀/仁王盾
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g.players[0].drank = 1;
    await g.resolveSlash(g.players[0], C('sha', 'spade', 7), [g.players[1]]);
    const jiuDmg = g._damages[g._damages.length - 1].amount;
    const g2 = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g2.players[0].equips.weapon = C('gudingdao', 'spade', 1);
    await g2.resolveSlash(g2.players[0], C('sha', 'spade', 7), [g2.players[1]]);
    const gdDmg = g2._damages[g2._damages.length - 1].amount;
    const g3 = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g3.players[1].equips.armor = C('renwang', 'club', 2);
    await g3.resolveSlash(g3.players[0], C('sha', 'spade', 7), [g3.players[1]]);
    t('T32', '酒/古锭刀/仁王盾', jiuDmg === 2 && gdDmg === 2 && g3.players[1].hp === 4, '酒杀=' + jiuDmg + '(应2)，古锭刀=' + gdDmg + '(应2)，仁王盾后hp=' + g3.players[1].hp + '(应4)');
  }
  // T33 黄天次数
  {
    const g = game([{ name: '张角', skills: ['leiji', 'guidao', 'huangtian'], role: 'lord', kingdom: '群', hp: 3, maxHp: 3 }, { name: '群甲', skills: [], kingdom: '群' }]);
    const p = g.players[1];
    p.hand = [C('shan', 'heart', 2), C('shan', 'diamond', 3)];
    g.handler = async (pl, req) => {
      if (req.type === 'play') return { action: req.actions.find((a) => a.skill === 'huangtian') };
      if (req.needsCards) return { cards: [req.needsCards.filterCards ? req.needsCards.filterCards[0] : p.hand[0].id] };
      if (req.type === 'chooseCards') return [req.cards[0].id];
      return null;
    };
    const acts1 = g.buildPlayActions(p);
    const a1 = acts1.find((a) => a.skill === 'huangtian');
    if (a1) await g.executeAction(p, Object.assign({}, a1, { cards: [p.hand[0].id], targets: [] }));
    const acts2 = g.buildPlayActions(p);
    const a2 = acts2.find((a) => a.skill === 'huangtian');
    t('T33', '黄天限一次', !a2, '官方：出牌阶段限一次。实际第二次仍可发动=' + !!a2);
  }
  // T34 白银狮子古锭刀 combo? 跳过
  // T35 集智/奇才/铁骑 快速功能检查
  {
    const g = game([{ name: '黄月英', skills: ['jizhi', 'qicai'] }]);
    g.deck = [C('sha', 'spade', 7), C('sha', 'club', 8), C('sha', 'heart', 9), C('sha', 'diamond', 10)];
    const before = g.players[0].hand.length;
    await g.useVirtualCard(g.players[0], [C('wuzhong', 'heart', 7)], 'wuzhong', null, []);
    const after = g.players[0].hand.length;
    t('T35', '集智摸牌', after - before === 3, '官方：使用普通锦囊摸1，无中再摸2。实际净增=' + (after - before) + '(应3)');
  }

  // ================= 第二批：卡牌与高频技能 =================
  // T36 天香
  {
    const g = game([{ name: '小乔', skills: ['tianxiang', 'hongyan'], hp: 3, maxHp: 3 }, { name: '甲', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    p.hand = [C('tao', 'heart', 3)];
    g.deck = [C('sha', 'spade', 7), C('sha', 'club', 8)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /天香/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCards' && /天香/.test(req.reason || '')) return [req.cards[0].id];
      if (req.type === 'chooseTargets' && /天香/.test(req.reason || '')) return [1];
      return null;
    };
    await g.damage({ source: q, target: p, amount: 1 });
    t('T36', '天香转移伤害', p.hp === 3 && q.hp === 3 && q.hand.length === 1, '小乔hp=' + p.hp + '(应3)，甲hp=' + q.hp + '(应3)，甲摸牌=' + q.hand.length + '(应1)');
  }
  // T37 方天画戟
  {
    const specs = [{ name: '甲', skills: [] }]; for (let i = 0; i < 4; i++) specs.push({ name: '乙' + i, skills: [] });
    const g = game(specs);
    const p = g.players[0];
    p.equips.weapon = C('fangtian', 'diamond', 12);
    p.hand = [C('sha', 'spade', 7)];
    const act = g.buildPlayActions(p).find((a) => a.kind === 'card' && a.as === 'sha');
    t('T37', '方天画戟多目标', act && act.maxTargets === 3, '最后手牌方天杀应可指定至多3目标。实际maxTargets=' + (act && act.maxTargets));
  }
  // T38 贯石斧
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    p.equips.weapon = C('guanshi', 'diamond', 5);
    p.hand = [C('sha', 'spade', 7), C('shan', 'heart', 2)];
    q.hand = [C('shan', 'diamond', 2)];
    g.handler = async (pl, req) => {
      if (pl.seat === 1 && req.type === 'response' && req.options && req.options.length) return { cardId: req.options[0].cardId };
      if (pl.seat === 0 && req.type === 'chooseOption' && /贯石斧/.test(req.reason || '')) return 'yes';
      if (pl.seat === 0 && req.type === 'chooseCards') return req.cards.slice(0, 2).map((c) => c.id);
      return null;
    };
    await g.resolveSlash(p, C('sha', 'spade', 7), [q]);
    t('T38', '贯石斧强制命中', q.hp === 3, '闪后弃两张应仍造成伤害。实际乙hp=' + q.hp + '(应3)');
  }
  // T39 青龙偃月刀
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    p.equips.weapon = C('qinglong', 'spade', 5);
    p.hand = [C('sha', 'club', 8)];
    q.hand = [C('shan', 'heart', 2)];
    g.handler = async (pl, req) => {
      if (pl.seat === 1 && req.type === 'response' && req.options && req.options.length) return { cardId: req.options[0].cardId };
      if (pl.seat === 0 && req.type === 'chooseOption' && /青龙/.test(req.reason || '')) return 'yes';
      return null;
    };
    await g.resolveSlash(p, C('sha', 'spade', 7), [q]);
    t('T39', '青龙偃月刀二次杀', q.hp === 3, '闪后应可再杀。实际乙hp=' + q.hp + '(应3)，slashCount=' + p.slashCount + '，canUseSlash=' + g.canUseSlash(p));
  }
  // T40 寒冰剑
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    p.equips.weapon = C('hanbing', 'spade', 2);
    q.hand = [C('shan', 'heart', 2), C('tao', 'heart', 3)];
    g.handler = async (pl, req) => {
      if (pl.seat === 0 && req.type === 'chooseOption' && /寒冰剑/.test(req.reason || '')) return 'yes';
      if (pl.seat === 0 && req.type === 'chooseCardFrom') return { zone: 'hand' };
      return null;
    };
    await g.resolveSlash(p, C('sha', 'spade', 7), [q]);
    t('T40', '寒冰剑防止伤害', q.hp === 4 && q.hand.length === 0, '应防止伤害并弃2牌。实际乙hp=' + q.hp + '(应4)，手牌=' + q.hand.length + '(应0)');
  }
  // T41 麒麟弓
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    p.equips.weapon = C('qilin', 'heart', 5);
    q.equips.defhorse = C('dilu', 'club', 5);
    g.handler = async (pl, req) => {
      if (pl.seat === 0 && req.type === 'chooseOption' && /麒麟弓/.test(req.reason || '')) return 'yes';
      return null;
    };
    await g.resolveSlash(p, C('sha', 'spade', 7), [q]);
    t('T41', '麒麟弓弃坐骑', q.hp === 3 && q.equips.defhorse === null, '应弃坐骑并造成伤害。实际乙hp=' + q.hp + '(应3)，坐骑=' + !!q.equips.defhorse);
  }
  // T42 八卦阵
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const q = g.players[1];
    q.equips.armor = C('bagua', 'spade', 2);
    g.deck = [C('shan', 'heart', 2)]; // 红
    g.handler = async (pl, req) => {
      if (pl.seat === 1 && req.type === 'chooseOption' && /八卦阵/.test(req.reason || '')) return 'yes';
      return null;
    };
    await g.resolveSlash(g.players[0], C('sha', 'spade', 7), [q]);
    t('T42', '八卦阵判定闪', q.hp === 4, '红色判定应视为闪。实际乙hp=' + q.hp + '(应4)');
  }
  // T43 藤甲免南蛮
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const q = g.players[1];
    q.equips.armor = C('tengjia', 'spade', 2);
    await g.resolveAOE(g.players[0], { id: -30, name: 'nanman', type: 'trick', suit: 'spade', color: 'black', cards: [] }, [q], 'sha', 1);
    t('T43', '藤甲免南蛮', q.hp === 4, '官方：南蛮对藤甲无效。实际乙hp=' + q.hp + '(应4)');
  }
  // T44 乐/兵粮/闪电判定
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    const lebu = C('lebu', 'spade', 6); lebu.type = 'delayed';
    p.judges = [lebu]; g.deck = [C('tao', 'heart', 3)];
    g.handler = async () => null;
    await g.phaseJudge(p);
    const lebuOk = p.skip.play !== true;
    const g2 = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const b = C('bingliang', 'spade', 10); b.type = 'delayed';
    g2.players[0].judges = [b]; g2.deck = [C('sha', 'club', 7)];
    await g2.phaseJudge(g2.players[0]);
    const blOk = g2.players[0].skip.draw !== true;
    const g3 = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const sd = C('shandian', 'heart', 12); sd.type = 'delayed';
    g3.players[0].judges = [sd]; g3.deck = [C('sha', 'spade', 5)];
    g3.handler = async () => null;
    await g3.phaseJudge(g3.players[0]);
    t('T44', '延时锦囊判定', lebuOk && blOk && g3.players[0].hp === 1, '乐红桃不跳=' + lebuOk + '，兵粮梅花不跳=' + blOk + '，闪电黑桃2-9应3伤后hp=' + g3.players[0].hp + '(应1)');
  }
  // T45 桃园/五谷
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g.players[0].hp = 3; g.players[1].hp = 2;
    await g.resolveVirtualCard(g.players[0], { id: -31, name: 'taoyuan', type: 'trick', color: 'heart', cards: [] }, [g.players[0], g.players[1]], {});
    const taoyuanOk = g.players[0].hp === 4 && g.players[1].hp === 3;
    const g2 = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g2.deck = [C('sha', 'spade', 7), C('tao', 'heart', 3)];
    g2.handler = async (pl, req) => req.type === 'pickFrom' ? req.cards[0].id : null;
    await g2.resolveWugu(g2.players[0], { id: -32, name: 'wugu', type: 'trick', color: 'heart', cards: [] }, [g2.players[0], g2.players[1]]);
    t('T45', '桃园/五谷', taoyuanOk && g2.players[0].hand.length === 1 && g2.players[1].hand.length === 1, '桃园回血=' + taoyuanOk + '，五谷各得1=' + (g2.players[0].hand.length + '/' + g2.players[1].hand.length));
  }
  // T46 仁德回血
  {
    const g = game([{ name: '刘备', skills: ['rende'], hp: 3, maxHp: 4 }, { name: '甲', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    p.hand = [C('sha', 'spade', 7), C('shan', 'heart', 2)];
    await g.useSkillAction(p, { skill: 'rende', cards: [p.hand[0].id], targets: [1] });
    await g.useSkillAction(p, { skill: 'rende', cards: [p.hand[0].id], targets: [1] });
    t('T46', '仁德回血', p.hp === 4 && q.hand.length === 2, '给2张应回复1点。实际刘备hp=' + p.hp + '(应4)，甲手牌=' + q.hand.length);
  }
  // T47 离间不可无懈
  {
    const g = game([{ name: '貂蝉', skills: ['lijian', 'biyue'] }, { name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    p.hand = [C('sha', 'spade', 7)];
    g.players[1].hand = [C('wuxie', 'spade', 11)];
    g.handler = async (pl, req) => {
      if (req.type === 'response' && req.need === 'sha') return null;
      if (req.type === 'chooseCards') return [req.cards[0].id];
      return null;
    };
    await g.useSkillAction(p, { skill: 'lijian', cards: [p.hand[0].id], targets: [1, 2] });
    const wuxie = g._asks.some((r) => r.need === 'wuxie');
    t('T47', '离间决斗不可无懈', wuxie === false, '官方：离间决斗不能被无懈。实际询问无懈=' + wuxie);
  }
  // T48 空城
  {
    const g = game([{ name: '甲', skills: [] }, { name: '诸葛亮', skills: ['guanxing', 'kongcheng'] }]);
    g.players[1].hand = [];
    const tg = g.legalTargetsFor(g.players[0], 'sha', null, null);
    t('T48', '空城', tg.indexOf(1) < 0, '空城无手牌不能成为杀目标。实际可选=' + JSON.stringify(tg));
  }
  // T49 谦逊
  {
    const g = game([{ name: '甲', skills: [] }, { name: '陆逊', skills: ['qianxun', 'lianying'] }]);
    g.players[1].hand = [C('shan', 'heart', 2)];
    const s1 = g.legalTargetsFor(g.players[0], 'shunshou', null, null);
    const s2 = g.legalTargetsFor(g.players[0], 'lebu', null, null);
    t('T49', '谦逊', s1.indexOf(1) < 0 && s2.indexOf(1) < 0, '不能成为顺手/乐目标。实际顺=' + JSON.stringify(s1) + '，乐=' + JSON.stringify(s2));
  }
  // T50 枭姬
  {
    const g = game([{ name: '孙尚香', skills: ['jieyin', 'xiaoji'] }]);
    g.deck = [C('sha', 'spade', 7), C('sha', 'club', 8), C('sha', 'heart', 9), C('sha', 'diamond', 10)];
    const p = g.players[0];
    const e1 = C('bagua', 'spade', 2), e2 = C('renwang', 'club', 2);
    p.equips.armor = e1; p.equips.weapon = e2; p.equips.armor = null; p.equips.weapon = null;
    await g.afterLoseCards(p, [e1, e2]);
    t('T50', '枭姬', p.hand.length === 4, '失去2张装备应摸4。实际摸=' + p.hand.length);
  }
  // T51 反间
  {
    const g = game([{ name: '周瑜', skills: ['yingzi', 'fanjian'] }, { name: '甲', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    p.hand = [C('sha', 'spade', 7)];
    g.handler = async (pl, req) => {
      if (pl.seat === 1 && req.type === 'chooseOption') return 'heart';
      return null;
    };
    await g.useSkillAction(p, { skill: 'fanjian', cards: [p.hand[0].id], targets: [1] });
    t('T51', '反间', q.hp === 3 && q.hand.length === 1, '花色不符应受伤。实际甲hp=' + q.hp + '(应3)，得牌=' + q.hand.length);
  }
  // T52 铁骑
  {
    const g = game([{ name: '马超', skills: ['mashu', 'tieji'] }, { name: '乙', skills: [] }]);
    const q = g.players[1];
    q.hand = [C('shan', 'diamond', 2)];
    g.deck = [C('tao', 'heart', 3)];
    let shanAsked = false;
    g.handler = async (pl, req) => {
      if (pl.seat === 0 && req.type === 'chooseOption' && /铁骑/.test(req.reason || '')) return 'yes';
      if (req.type === 'response' && req.need === 'shan') { shanAsked = true; return { cardId: req.options[0].cardId }; }
      return null;
    };
    await g.resolveSlash(g.players[0], C('sha', 'spade', 7), [q]);
    t('T52', '铁骑红判定禁闪', q.hp === 3 && shanAsked === false, '红色判定目标不能闪。实际乙hp=' + q.hp + '(应3)，询问闪=' + shanAsked);
  }
  // T53 烈弓
  {
    const g = game([{ name: '黄忠', skills: ['liegong'] }, { name: '乙', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    for (let i = 0; i < 4; i++) q.hand.push(C('shan', 'heart', 2));
    let shanAsked = false;
    g.handler = async (pl, req) => {
      if (pl.seat === 0 && req.type === 'chooseOption' && /烈弓/.test(req.reason || '')) return 'yes';
      if (req.type === 'response' && req.need === 'shan') { shanAsked = true; return { cardId: req.options[0].cardId }; }
      return null;
    };
    await g.resolveSlash(p, C('sha', 'spade', 7), [q]);
    t('T53', '烈弓禁闪', q.hp === 3, '手牌≥体力应可禁闪。实际乙hp=' + q.hp + '(应3)，询问闪=' + shanAsked);
  }
  // T54 完杀
  {
    const g = game([{ name: '贾诩', skills: ['wansha', 'luanwu', 'weimu'], role: 'lord' }, { name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g.currentSeat = 0;
    g.players[1].hand = [C('tao', 'heart', 3)];
    const r = await g.askForPeach(g.players[1], g.players[2]);
    t('T54', '完杀', r === null, '贾诩回合内其他角色不能用桃。实际可用=' + (r !== null));
  }
  // T55 帷幕
  {
    const g = game([{ name: '甲', skills: [] }, { name: '贾诩', skills: ['wansha', 'luanwu', 'weimu'] }]);
    const black = C('juedou', 'spade', 1);
    const tg = g.legalTargetsFor(g.players[0], 'juedou', null, [black]);
    const red = C('juedou', 'heart', 1);
    const tg2 = g.legalTargetsFor(g.players[0], 'juedou', null, [red]);
    t('T55', '帷幕黑锦囊', tg.indexOf(1) < 0 && tg2.indexOf(1) >= 0, '不能成为黑锦囊目标。实际黑=' + JSON.stringify(tg) + '，红=' + JSON.stringify(tg2));
  }
  // T56 无懈链
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g.players[0].hand = [C('wuxie', 'spade', 11)];
    g.players[1].hand = [C('wuxie', 'club', 12)];
    let n = 0;
    g.handler = async (pl, req) => { if (req.need === 'wuxie' && req.options && req.options.length) { n++; return { cardId: req.options[0].cardId }; } return null; };
    const vc = { id: -40, name: 'guohe', type: 'trick', suit: 'spade', color: 'black', cards: [] };
    const res = await g.isNullified(vc, g.players[0], g.players[1]);
    t('T56', '无懈链反抵消', n === 2 && res === false, '两张无懈应互相抵消。实际询问次数=' + n + '，结果=' + res);
  }
  // T57 借刀
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }, { name: '丙', skills: [] }]);
    const p = g.players[0], killer = g.players[1], victim = g.players[2];
    killer.equips.weapon = C('qinglong', 'spade', 5);
    killer.hand = [C('sha', 'spade', 7)];
    g.handler = async (pl, req) => {
      if (pl.seat === 1 && req.type === 'response' && req.options && req.options.length) return { cardId: req.options[0].cardId };
      return null;
    };
    await g.resolveCollateral(p, { id: -41, name: 'jiedao', type: 'trick', color: 'club', cards: [] }, [killer, victim]);
    t('T57', '借刀杀人', victim.hp === 3 && killer.equips.weapon !== null, '借刀应令其出杀并保留武器。实际丙hp=' + victim.hp + '(应3)，武器=' + !!killer.equips.weapon);
  }
  // T58 化身只取第一个技能
  {
    const g = game([{ name: '左慈', skills: ['huashen', 'xinsheng'], hp: 3, maxHp: 3 }]);
    g.initHuashen(g.players[0]);
    await g.ensureHuashenSkill(g.players[0]);
    const p = g.players[0];
    const added = p.skills.filter((s) => !['huashen', 'xinsheng'].includes(s));
    t('T58', '化身技能数', added.length === 1, '官方：获得化身牌上的一个技能。实际新增技能=' + JSON.stringify(added) + '（刘备含2技能，应只1个）');
  }


  // ================= 第三批：卡牌细则 =================
  // T59 属性杀与藤甲
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g.players[1].equips.armor = C('tengjia', 'spade', 2);
    await g.resolveSlash(g.players[0], C('huosha', 'heart', 4), [g.players[1]]);
    const fireHp = g.players[1].hp;
    const g2 = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g2.players[1].equips.armor = C('tengjia', 'spade', 2);
    await g2.resolveSlash(g2.players[0], C('leisha', 'spade', 4), [g2.players[1]]);
    const thunderHp = g2.players[1].hp;
    t('T59', '属性杀与藤甲', fireHp === 2 && thunderHp === 3, '火杀应命中并+1（hp2），雷杀应命中（hp3）。实际火杀后=' + fireHp + '，雷杀后=' + thunderHp);
  }
  // T60 朱雀羽扇
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    p.equips.weapon = C('zhuque', 'diamond', 1);
    p.hand = [C('sha', 'spade', 7)];
    const act = g.buildPlayActions(p).find((a) => a.skill === 'zhuque' && a.as === 'huosha');
    t('T60', '朱雀羽扇', !!act, '应提供“普通杀→火杀”动作。实际=' + !!act);
  }
  // T61 铁索重铸
  {
    const g = game([{ name: '甲', skills: [] }]);
    const p = g.players[0];
    const ts = C('tiesuo', 'spade', 11);
    p.hand = [ts];
    g.deck = [C('sha', 'spade', 7)];
    await g.useVirtualCard(p, [ts], 'tiesuo', null, []);
    t('T61', '铁索重铸', p.hand.length === 1 && g.discardPile.indexOf(ts) >= 0, '重铸应弃铁索摸1。实际手牌=' + p.hand.length + '，弃牌堆有铁索=' + (g.discardPile.indexOf(ts) >= 0));
  }
  // T62 火攻
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    p.hand = [C('shan', 'heart', 2)];
    q.hand = [C('tao', 'heart', 3)];
    g.handler = async (pl, req) => req.type === 'chooseCards' ? [req.cards[0].id] : null;
    await g.resolveFireAttack(p, { id: -50, name: 'huogong', type: 'trick', suit: 'heart', color: 'red', cards: [] }, q);
    t('T62', '火攻', q.hp === 3, '展示红桃后弃同花色应造成1点火焰伤害。实际乙hp=' + q.hp + '(应3)');
  }
  // T63 酒跨回合残留
  {
    const g = game([{ name: '甲', skills: [] }]);
    g.players[0].drank = 1;
    ['phaseStart', 'phaseJudge', 'phaseDraw', 'phasePlay', 'phaseDiscard', 'phaseEnd'].forEach((m) => { g[m] = async () => {}; });
    await g.takeTurn();
    t('T63', '酒跨回合残留', g.players[0].drank === 0, '酒状态应在新回合清空。实际新回合后 drank=' + g.players[0].drank + '（>0 会屏蔽再次用酒并给下一张杀+1）');
  }


  // T64 1v1 胜负判定应按身份而非座位
  {
    const g = new SGS.Game({ mode: '1v1', seed: 1, humanSeat: -1, onUpdate() {} });
    g.players = [P({ name: '甲', role: 'rebel' }, 0), P({ name: '乙', role: 'loyalist' }, 1)];
    g.players[0].alive = false; g.players[1].alive = true;
    g.over = false; g.winner = null;
    g.checkWin();
    t('T64', '1v1胜负判定', g.winner === 'loyalist', '1号位反贼阵亡、2号位忠臣存活，胜方应为忠臣。实际 winner=' + g.winner);
  }
  // T65 1v1 座次身份应固定
  {
    let rebelAt0 = 0;
    for (let i = 0; i < 40; i++) {
      const g = new SGS.Game({ mode: '1v1', seed: i, humanSeat: -1, onUpdate() {} });
      g.setup();
      if (g.players[0].role === 'rebel') rebelAt0++;
    }
    t('T65', '1v1座次身份', rebelAt0 === 0, '官方：忠臣固定1号位、反贼2号位。40次 setup 中1号位为反贼 ' + rebelAt0 + ' 次');
  }


  // T66 火攻 + 无懈：目标手牌被无懈打空后崩溃
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }, { name: '丙', skills: [] }]);
    const p = g.players[0], q = g.players[1], r = g.players[2];
    p.hand = [C('shan', 'heart', 2)];
    q.hand = [C('wuxie', 'spade', 11)];
    r.hand = [C('wuxie', 'club', 12)];
    g.handler = async (pl, req) => {
      if (req.need === 'wuxie') {
        if (pl.seat === 1 && !req.negated && req.options && req.options.length) return { cardId: req.options[0].cardId };
        if (pl.seat === 2 && req.negated && req.options && req.options.length) return { cardId: req.options[0].cardId };
      }
      return null;
    };
    let err = null;
    try {
      await g.resolveFireAttack(p, { id: -60, name: 'huogong', type: 'trick', suit: 'heart', color: 'red', cards: [] }, q);
    } catch (e) { err = e.message; }
    t('T66', '火攻+无懈崩溃', err === null, '目标用【无懈】后手牌为空，火攻仍取手牌应不崩溃。实际=' + (err || '正常'));
  }

  // T67 无中生有：第三方持有【无懈可击】应被询问并可抵消
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }, { name: '丙', skills: [] }]);
    const user = g.players[0], human = g.players[1];
    const wz = C('wuzhong', 'heart', 7);
    user.hand = [wz];
    human.hand = [C('wuxie', 'spade', 11)];
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3)];
    let asked = false, pending = null;
    g.handler = async (pl, req) => {
      if (req.need === 'wuxie' && pl.seat === 1 && !req.negated) {
        asked = true;
        pending = g.pendingRequest ? g.pendingRequest.type + '/' + g.pendingRequest.need : 'null';
        return req.options && req.options.length ? { cardId: req.options[0].cardId } : null;
      }
      return null;
    };
    await g.useVirtualCard(user, [wz], 'wuzhong', null, [user], {});
    const canceled = g.logs.some((e) => /【无中生有】被【无懈可击】抵消/.test(e.text));
    t('T67', '无中生有可被无懈', asked && pending === 'response/wuxie' && user.hand.length === 0 && canceled,
      '第三方被询问=' + asked + '，pending=' + pending + '（应 response/wuxie），用无懈后Caster手牌=' + user.hand.length + '（应0：无中被弃且未摸牌），抵消日志=' + canceled);
  }

  // T68 无中生有：无人使用无懈时应正常摸两张
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }, { name: '丙', skills: [] }]);
    const user = g.players[0], human = g.players[1];
    const wz = C('wuzhong', 'heart', 7);
    user.hand = [wz];
    human.hand = [C('wuxie', 'spade', 11)];
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3)];
    let asked = false;
    g.handler = async (pl, req) => { if (req.need === 'wuxie') asked = true; return null; };
    await g.useVirtualCard(user, [wz], 'wuzhong', null, [user], {});
    t('T68', '无中生有未被无懈', asked && user.hand.length === 2,
      '应被询问=' + asked + '，拒绝后Caster手牌=' + user.hand.length + '（应2：用掉无中后摸两张）');
  }

  // T69 无中生有：无懈本身被反无懈 -> 无中恢复生效
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }, { name: '丙', skills: [] }]);
    const user = g.players[0], human = g.players[1], other = g.players[2];
    const wz = C('wuzhong', 'heart', 7);
    user.hand = [wz];
    human.hand = [C('wuxie', 'spade', 11)];
    other.hand = [C('wuxie', 'club', 12)];
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3)];
    g.handler = async (pl, req) => {
      if (req.need === 'wuxie') {
        if (pl.seat === 1 && !req.negated && req.options && req.options.length) return { cardId: req.options[0].cardId };
        if (pl.seat === 2 && req.negated && req.options && req.options.length) return { cardId: req.options[0].cardId };
      }
      return null;
    };
    await g.useVirtualCard(user, [wz], 'wuzhong', null, [user], {});
    const counter = g.logs.some((e) => /反抵消/.test(e.text));
    t('T69', '无中对无懈链', counter && user.hand.length === 2,
      '无懈被反无懈后无中应生效：反抵消日志=' + counter + '，Caster手牌=' + user.hand.length + '（应2）');
  }

  // T70 看破：黑色手牌当【无懈可击】抵消无中生有
  {
    const g = game([{ name: '甲', skills: [] }, { name: '于吉', skills: ['kanpo'] }, { name: '丙', skills: [] }]);
    const user = g.players[0], human = g.players[1];
    const wz = C('wuzhong', 'heart', 7);
    user.hand = [wz];
    human.hand = [C('sha', 'spade', 5)];
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3)];
    let opt = null;
    g.handler = async (pl, req) => {
      if (req.need === 'wuxie' && pl.seat === 1 && !req.negated) {
        opt = req.options[0];
        return { cardId: opt.cardId, as: opt.as, skill: opt.skill };
      }
      return null;
    };
    await g.useVirtualCard(user, [wz], 'wuzhong', null, [user], {});
    const canceled = g.logs.some((e) => /【无中生有】被【无懈可击】抵消/.test(e.text));
    t('T70', '看破当无懈', !!opt && opt.skill === 'kanpo' && user.hand.length === 0 && canceled,
      '看破选项skill=' + (opt && opt.skill) + '（应kanpo），Caster手牌=' + user.hand.length + '（应0），抵消日志=' + canceled);
  }


  // ================= 第三批：死亡后触发审计 =================
  // T71 司马懿 1 血被致命伤害：不应再询问【反馈】，且直接阵亡
  {
    const g = game([{ name: '司马懿', skills: ['fankui', 'guicai'], hp: 1, maxHp: 3 }, { name: '甲', skills: [] }]);
    const p = g.players[0], src = g.players[1];
    src.hand = [C('sha', 'spade', 7), C('tao', 'heart', 2)];
    let asked = false;
    g.handler = async (pl, req) => { if (req.type === 'chooseOption' && /反馈/.test(req.reason || '')) { asked = true; return 'yes'; } return null; };
    await g.damage({ source: src, target: p, amount: 1, card: C('sha', 'club', 5) });
    const toDead = g._asks.filter((r) => r._askerAlive === false).length;
    t('T71', '死亡后不发动反馈', !asked && p.alive === false && p.hand.length === 0 && toDead === 0,
      '致命伤害未救回：询问反馈=' + asked + '（应false），alive=' + p.alive + '（应false），获得牌=' + p.hand.length + '（应0），死者收到请求=' + toDead + '（应0）');
  }

  // T72 司马懿未致死：受伤后技能正常发动
  {
    const g = game([{ name: '司马懿', skills: ['fankui', 'guicai'], hp: 3, maxHp: 3 }, { name: '甲', skills: [] }]);
    const p = g.players[0], src = g.players[1];
    src.hand = [C('sha', 'spade', 7)];
    let asked = false;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /反馈/.test(req.reason || '')) { asked = true; return 'yes'; }
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      return null;
    };
    await g.damage({ source: src, target: p, amount: 1, card: C('sha', 'club', 5) });
    t('T72', '未致死正常反馈', asked && p.alive === true && p.hp === 2 && p.hand.length === 1,
      '非致命伤害：询问反馈=' + asked + '（应true），hp=' + p.hp + '（应2），获得牌=' + p.hand.length + '（应1）');
  }

  // T73 濒死被救回后仍可发动反馈
  {
    const g = game([{ name: '司马懿', skills: ['fankui', 'guicai'], hp: 1, maxHp: 3 }, { name: '乙', skills: [] }, { name: '甲', skills: [] }]);
    const p = g.players[0], healer = g.players[1], src = g.players[2];
    const tao = C('tao', 'heart', 2);
    healer.hand = [tao]; src.hand = [C('sha', 'spade', 7)];
    let asked = false;
    g.handler = async (pl, req) => {
      if (req.need === 'tao') return { cardId: tao.id };
      if (req.type === 'chooseOption' && /反馈/.test(req.reason || '')) { asked = true; return 'yes'; }
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      return null;
    };
    await g.damage({ source: src, target: p, amount: 1, card: C('sha', 'club', 5) });
    t('T73', '救回后可反馈', p.alive === true && p.hp === 1 && asked && p.hand.length === 1,
      '濒死被【桃】救回：alive=' + p.alive + '，hp=' + p.hp + '（应1），询问反馈=' + asked + '，获得牌=' + p.hand.length);
  }

  // T74 曹操致命伤：不应发动【奸雄】获得伤害牌
  {
    const g = game([{ name: '曹操', skills: ['jianxiong'], hp: 1, maxHp: 4 }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    const phys = C('sha', 'spade', 7);
    const vc = { id: phys.id, name: 'sha', type: 'basic', nature: 'normal', suit: 'spade', rank: 7, color: 'black', cards: [phys] };
    g.table.push(vc);
    let asked = false;
    g.handler = async (pl, req) => { if (req.type === 'chooseOption' && /奸雄/.test(req.reason || '')) { asked = true; return 'yes'; } return null; };
    await g.damage({ source: g.players[1], target: p, amount: 1, card: vc });
    t('T74', '死亡后不发动奸雄', !asked && p.alive === false && !p.hand.some((c) => c.id === phys.id),
      '致命伤害：询问奸雄=' + asked + '（应false），alive=' + p.alive + '，是否获得伤害牌=' + p.hand.some((c) => c.id === phys.id) + '（应false）');
  }

  // T75 夏侯惇致命伤：不应发动【刚烈】反伤来源
  {
    const g = game([{ name: '夏侯惇', skills: ['ganglie'], hp: 1, maxHp: 4 }, { name: '甲', skills: [] }]);
    const p = g.players[0], src = g.players[1];
    let asked = false;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /刚烈/.test(req.reason || '')) { asked = true; return 'yes'; }
      if (req.type === 'chooseOption') return 'damage';
      return null;
    };
    await g.damage({ source: src, target: p, amount: 1 });
    t('T75', '死亡后不发动刚烈', !asked && p.alive === false && src.hp === 4,
      '致命伤害：询问刚烈=' + asked + '（应false），夏侯惇alive=' + p.alive + '，来源hp=' + src.hp + '（应4，未被反伤）');
  }

  // T76 失去体力致死：必须真正阵亡；onDeath 只触发一次；不再向死者发请求
  {
    const g = game([{ name: '甲', skills: [], hp: 1, maxHp: 4 }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    g.handler = async () => null;
    let deathEvents = 0;
    const orig = g.skillTrigger.bind(g);
    g.skillTrigger = async (ev, pl, data) => { if (ev === 'onDeath') deathEvents++; return orig(ev, pl, data); };
    await g.loseHp(p, 1, '测试');
    const toDead = g._asks.filter((r) => r._askerAlive === false).length;
    t('T76', '失去体力致死与onDeath一次', p.alive === false && deathEvents === 1 && toDead === 0,
      '失去体力致死：alive=' + p.alive + '（应false），onDeath触发=' + deathEvents + '（应1），死者收到请求=' + toDead + '（应0）');
  }

  // T77 已阵亡角色不得再收到 ask 请求（Game.ask 守卫）
  {
    const g = new SGS.Game({ mode: '8p', seed: 42, humanSeat: -1, onUpdate() {} });
    g.players = [{ name: '甲' }, { name: '乙' }].map((s, i) => P(s, i));
    g.currentSeat = 0; g.deck = []; g.discardPile = []; g.table = []; g.logs = [];
    g.pause = async () => {}; g.checkWin = () => {};
    let agentCalls = 0;
    g.agents = [{ decide: async () => { agentCalls++; return 'yes'; } }, { decide: async () => { agentCalls++; return 'yes'; } }];
    const dead = g.players[0];
    dead.alive = false;
    dead.hand = [C('wuxie', 'spade', 11)];
    const r = await g.ask(dead, { type: 'chooseOption', player: dead, reason: '测试', options: [{ id: 'yes', label: '是' }] });
    t('T77', '死亡后不再询问', r === null && agentCalls === 0,
      '对已阵亡角色调用 ask：返回=' + JSON.stringify(r) + '（应null），agent 被调用=' + agentCalls + '（应0）');
  }


  // ================= 第四批：限定技/死亡触发/队伍数值/独立将池 =================
  // T78 涅槃：选择“不发动”不应消耗限定技
  {
    const g = game([{ name: '庞统', skills: ['niepan'], hp: 1, maxHp: 4 }]);
    const p = g.players[0];
    g.deck = [C('shan', 'heart', 2), C('shan', 'club', 3), C('sha', 'spade', 4)];
    let stage = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /涅槃/.test(req.reason || '')) return stage === 0 ? 'no' : 'yes';
      return null;
    };
    p.hp = 0;
    stage = 0; await g.dying(p, null);
    const declined = { alive: p.alive, hp: p.hp, used: !!p.once.niepan };
    stage = 1; await g.dying(p, null);
    t('T78', '涅槃拒绝不消耗', declined.alive === true && declined.hp <= 0 && declined.used === false && p.hp === 3,
      '首次拒绝：alive=' + declined.alive + '，hp=' + declined.hp + '，已消耗=' + declined.used + '（应false）；再次发动后hp=' + p.hp + '（应3）');
  }

  // T79 遗计：分配候选不能包含已阵亡角色
  {
    const g = game([{ name: '郭嘉', skills: ['yiji'], hp: 3, maxHp: 3 }, { name: '甲', skills: [] }, { name: '乙', skills: [] }, { name: '死者', skills: [] }]);
    g.players[3].alive = false;
    let cands = null, asked = false;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /遗计/.test(req.reason || '')) return 'yes';
      if (req.type === 'distribute') { asked = true; cands = (req.candidates || []).slice(); return (req.cards || []).map((c) => ({ cardId: c.id, seat: 0 })); }
      return null;
    };
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3)];
    await g.damage({ source: g.players[1], target: g.players[0], amount: 1 });
    t('T79', '遗计只分配存活角色', asked && Array.isArray(cands) && cands.indexOf(3) < 0 && cands.length === 3,
      '遗计分配候选=' + JSON.stringify(cands) + '（应不含已阵亡座位3，共3名存活）');
  }

  // T80 不屈：判定失败的牌不应留在「不屈」区
  {
    const g = game([{ name: '周泰', skills: ['buqu'], hp: 1, maxHp: 4 }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    const old = C('sha', 'club', 5), fail = C('sha', 'spade', 5);
    p.marks.buqu = [old];
    g.deck = [fail];
    g.handler = async () => null;
    p.hp = 0;
    await g.dying(p, null);
    const onMark = p.marks.buqu.some((c) => c.id === fail.id);
    const inDiscard = g.discardPile.some((c) => c.id === fail.id);
    t('T80', '不屈失败牌不进不屈区', onMark === false && inDiscard === true && p.marks.buqu.length === 1,
      '失败牌在不屈区=' + onMark + '（应false），进弃牌堆=' + inDiscard + '（应true），不屈牌数=' + p.marks.buqu.length + '（应1）');
  }

  // T81 欢乐33：六号位起手 5 张，其他位置 4 张
  {
    const g = new SGS.Game({ mode: '3v3', seed: 7, humanSeat: -1, onUpdate() {} });
    g.agents = Array.from({ length: 6 }, (_, i) => new SGS.AI(g, i, { speed: 0 }));
    g.runLoop = async () => {}; // 只走 setup/draft/发牌
    await g.start();
    const hands = g.players.map((p) => p.hand.length);
    t('T81', '欢乐33六号位起手5张', hands[5] === 5 && hands.slice(0, 5).every((n) => n === 4),
      '起手手牌=' + JSON.stringify(hands) + '（应前五位4、六号位5）');
  }

  // T82 欢乐33：首轮一号位摸 1 张，其他位置摸 2 张
  {
    const g = game([{ seat: 0 }, { seat: 1 }, { seat: 2 }, { seat: 3 }, { seat: 4 }, { seat: 5 }], { mode: '3v3' });
    g.deck = Array.from({ length: 12 }, () => C('sha', 'spade', 7));
    g.turnCount = 1;
    const b0 = g.players[0].hand.length;
    await g.phaseDraw(g.players[0]);
    const d0 = g.players[0].hand.length - b0;
    g.turnCount = 2;
    const b1 = g.players[1].hand.length;
    await g.phaseDraw(g.players[1]);
    const d1 = g.players[1].hand.length - b1;
    t('T82', '欢乐33首轮摸牌', d0 === 1 && d1 === 2, '首轮一号位摸=' + d0 + '（应1），其他位置摸=' + d1 + '（应2）');
  }

  // T83 欢乐33：双方阵营随机一方先手
  {
    const starts = {};
    for (let i = 0; i < 12; i++) {
      const g = new SGS.Game({ mode: '3v3', seed: 300 + i, humanSeat: -1, onUpdate() {} });
      g.agents = Array.from({ length: 6 }, (_, j) => new SGS.AI(g, j, { speed: 0 }));
      let first = null;
      g.runLoop = async () => { first = g.currentSeat; };
      await g.start();
      starts[first] = (starts[first] || 0) + 1;
    }
    t('T83', '欢乐33随机先手', !!starts[0] && !!starts[1], '12 局首手座位分布=' + JSON.stringify(starts) + '（应 0/1 都出现）');
  }

  // T84 化身：结束阶段也可替换展示的化身牌
  {
    const g = game([{ name: '左慈', skills: ['huashen', 'xinsheng'] }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    g.initHuashen(p);
    const activeBefore = p.marks.huashen.active;
    let asked = false;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /是否替换/.test(req.reason || '')) { asked = true; return 'yes'; }
      if (req.type === 'chooseOption' && /选择要展示的化身牌/.test(req.reason || '')) return String((activeBefore + 1) % p.marks.huashen.options.length);
      if (req.type === 'chooseOption' && /选择获得/.test(req.reason || '')) return (req.options[0] || {}).id;
      return null;
    };
    await g.skillEndPhase(p);
    t('T84', '化身结束阶段可替换', asked && p.marks.huashen.active !== activeBefore,
      '结束阶段询问=' + asked + '，active ' + activeBefore + '→' + p.marks.huashen.active + '（应变化）');
  }

  // T85 斗地主：任意角色阵亡即结束（地主死→农民胜；否则地主胜）
  {
    const mk = () => game([{ name: '地主', role: 'landlord' }, { name: '农1', role: 'farmer' }, { name: '农2', role: 'farmer' }], { mode: 'ddz' });
    const g1 = mk(); g1.checkWin = SGS.Game.prototype.checkWin.bind(g1);
    await g1.kill(g1.players[1], null);
    const g2 = mk(); g2.checkWin = SGS.Game.prototype.checkWin.bind(g2);
    await g2.kill(g2.players[0], null);
    t('T85', '斗地主任意阵亡结束', g1.over === true && g1.winner === 'landlord' && g2.over === true && g2.winner === 'farmer',
      '农民阵亡→over=' + g1.over + ',winner=' + g1.winner + '（应true/landlord）；地主阵亡→over=' + g2.over + ',winner=' + g2.winner + '（应true/farmer）');
  }

  // T86 1v1：独立将池（不受武将包勾选影响）；经典池仅含原版 59 池中可用者
  {
    let sawNonStandard = false, classicOk = true;
    for (let i = 0; i < 20; i++) {
      const g = new SGS.Game({ mode: '1v1', seed: 500 + i, humanSeat: -1, packs: ['标准'], duelPool: 'all', onUpdate() {} });
      g.setup();
      if (g.players.some((p) => p.candidates.some((c) => c.pack !== '标准'))) sawNonStandard = true;
      const gc = new SGS.Game({ mode: '1v1', seed: 600 + i, humanSeat: -1, packs: ['标准'], duelPool: 'classic', onUpdate() {} });
      gc.setup();
      if (!gc.players.every((p) => p.candidates.every((c) => D.DUEL_POOL.indexOf(c.name) >= 0))) classicOk = false;
    }
    t('T86', '1v1独立将池', sawNonStandard && classicOk,
      '仅勾选标准包时"全武将"池出现非标准候选=' + sawNonStandard + '（应true）；经典池仅含经典武将=' + classicOk);
  }

  // T87 1v1：军争剪裁 108 张（52 禁牌表）
  {
    const g = new SGS.Game({ mode: '1v1', seed: 1, humanSeat: -1, onUpdate() {} });
    g.setup(); g.buildDeck();
    const count = (n) => g.deck.filter((c) => c.name === n).length;
    const total = g.deck.length, uniq = new Set(g.deck.map((c) => c.id)).size;
    const sha = count('sha'), shan = count('shan'), tao = count('tao'), wuxie = count('wuxie'), tiesuo = count('tiesuo'), shun = count('shunshou'), jiu = count('jiu');
    t('T87', '1v1军争剪裁108张', total === 108 && uniq === 108 && sha === 18 && shan === 14 && tao === 8 && wuxie === 4 && tiesuo === 3 && shun === 3 && jiu === 3,
      '总数=' + total + '(108)，去重=' + uniq + '，杀=' + sha + '(18) 闪=' + shan + '(14) 桃=' + tao + '(8) 无懈=' + wuxie + '(4) 铁索=' + tiesuo + '(3) 顺手=' + shun + '(3) 酒=' + jiu + '(3)');
  }


  // T88 觉醒技【魂姿】只发动一次
  {
    const g = game([{ name: '孙策', skills: ['hunzi'], hp: 1, maxHp: 4 }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    g.handler = async (pl, req) => { if (req.type === 'chooseOption' && /英魂/.test(req.reason || '')) return 'no'; return null; };
    await g.skillPhaseStart(p);
    const hp1 = p.maxHp, once1 = !!p.once.hunzi;
    await g.skillPhaseStart(p);
    t('T88', '魂姿觉醒只一次', once1 && hp1 === 3 && p.maxHp === 3 && p.skills.includes('yingzi') && p.skills.includes('yinghun'),
      '第一次后 maxHp=' + hp1 + '（应3）且获得英姿英魂；再次准备阶段 maxHp=' + p.maxHp + '（应仍3），once=' + once1);
  }

  // T89 觉醒技【凿险】授予【急袭】并可用
  {
    const g = game([{ name: '邓艾', skills: ['tuntian', 'zaoxian'], hp: 4, maxHp: 4 }, { name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    g.players[1].hand = [C('sha', 'heart', 2)];
    p.marks.tian = 3;
    g.handler = async () => null;
    await g.skillPhaseStart(p);
    const gained = p.skills.includes('jixi');
    const acts = g.buildPlayActions(p);
    const act = acts.find((a) => a.skill === 'jixi');
    t('T89', '凿险觉醒授予急袭', gained && p.maxHp === 3 && !!act,
      '获得急袭=' + gained + '，maxHp=' + p.maxHp + '（应3），出牌阶段急袭动作=' + !!act);
  }

  // T90 斗地主：叫地主后抢地主每次 ×2，地主 +2 体力/起手 6 张
  {
    const g = game([{ name: 'P0', skills: [], role: 'farmer' }, { name: 'P1', skills: [], role: 'farmer' }, { name: 'P2', skills: [], role: 'farmer' }], { mode: 'ddz' });
    for (const p of g.players) p.hand = [C('sha', 'spade', 2), C('sha', 'club', 3), C('shan', 'heart', 4), C('shan', 'diamond', 5)];
    g.deck = [C('tao', 'heart', 6), C('tao', 'heart', 7)];
    let asked = 0;
    g.handler = async (pl, req) => { if (req.type === 'chooseOption') { asked++; return asked === 1 ? 'call' : 'rob'; } return null; };
    await g.ddzAuction();
    const lord = g.players.find((p) => p.role === 'landlord');
    t('T90', '斗地主叫抢倍率', g.ddzMultiplier === 4 && !!lord && lord.maxHp === 4 && lord.hand.length === 6,
      '叫+两次抢后倍率=' + g.ddzMultiplier + '（应4），地主 maxHp=' + (lord && lord.maxHp) + '（应4：固定体力），起手=' + (lord && lord.hand.length) + '（应6）');
  }


  // T91 致命伤后：节命/放逐/新生均不得触发（死亡后触发审计）
  {
    const mk = (name, skill) => {
      const g = game([{ name, skills: [skill], hp: 1, maxHp: 3 }, { name: '甲', skills: [] }]);
      g.handler = async (pl, req) => (req.type === 'chooseOption' ? 'yes' : null);
      return g;
    };
    const g1 = mk('荀彧', 'jieming');
    await g1.damage({ source: g1.players[1], target: g1.players[0], amount: 1 });
    const g2 = mk('曹丕', 'fangzhu');
    await g2.damage({ source: g2.players[1], target: g2.players[0], amount: 1 });
    const g3 = mk('左慈', 'xinsheng');
    g3.players[0].marks.huashen = { options: [{ general: { id: 1, name: '占位', hp: 4, kingdom: '群', gender: 'male', skills: [] }, skill: 'rende' }], active: 0 };
    await g3.damage({ source: g3.players[1], target: g3.players[0], amount: 1 });
    const asked = (g, re) => g._asks.some((r) => re.test(r.reason || '') || re.test(String(r.type || '')));
    const xinSheng = g3.players[0].marks.huashen.options.length === 1 && !/新生/.test((g3.logs || []).map((e) => e.text).join('|'));
    t('T91', '死亡后不触发节命/放逐/新生', !asked(g1, /节命/) && !asked(g2, /放逐/) && xinSheng && !g1.players[0].alive && !g2.players[0].alive && !g3.players[0].alive,
      '节命询问=' + asked(g1, /节命/) + '（应false），放逐询问=' + asked(g2, /放逐/) + '（应false），新生未新增加身=' + xinSheng + '，三人存活=' + [g1, g2, g3].map((g) => g.players[0].alive).join('/'));
  }


  // ================= 第五批：蛊惑声明表 / 化身选技能 =================
  // T92 蛊惑声明表覆盖全部基本牌+普通锦囊，排除装备/延时锦囊
  {
    const g = game([{ name: '于吉', skills: ['guhuo'], hp: 3, maxHp: 3 }, { name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    const phys = C('shan', 'diamond', 6);
    p.hand = [phys];
    let decl = null;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && req.options && req.options.some((o) => o.id === 'yes')) return 'no';
      if (req.type === 'chooseOption' && /声明一张牌/.test(req.reason || '')) { decl = req.options.map((o) => o.id); return 'shan'; }
      return null;
    };
    await g.useSkillAction(p, { skill: 'guhuo', cards: [phys.id], targets: [] });
    const need = ['shan', 'wuxie', 'wugu', 'jiu', 'jiedao', 'huogong', 'tiesuo', 'sha', 'tao', 'wuzhong', 'guohe', 'shunshou', 'juedou', 'nanman', 'wanjian', 'taoyuan', 'huosha', 'leisha'];
    const hasAll = need.every((n) => decl && decl.indexOf(n) >= 0);
    const noBad = !decl || !decl.some((n) => ['lebu', 'bingliang', 'qinglong', 'bagua'].indexOf(n) >= 0);
    const noEffect = g.logs.some((e) => /只能在响应时使用/.test(e.text));
    t('T92', '蛊惑声明表', hasAll && noBad && noEffect && p.hand.length === 0,
      '声明选项数=' + (decl ? decl.length : 0) + '，含全部基本/普通锦囊=' + hasAll + '，排除装备/延时=' + noBad + '，闪无效果日志=' + noEffect);
  }

  // T93 蛊惑声明【无懈可击】真牌红桃被质疑：质疑者失1体力，仍按红桃结算（无效果）
  {
    const g = game([{ name: '于吉', skills: ['guhuo'], hp: 3, maxHp: 3 }, { name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    const phys = C('wuxie', 'heart', 11);
    p.hand = [phys];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /声明一张牌/.test(req.reason || '')) return 'wuxie';
      if (req.type === 'chooseOption' && /是否质疑/.test(req.reason || '')) return pl.seat === 1 ? 'yes' : 'no';
      return null;
    };
    await g.useSkillAction(p, { skill: 'guhuo', cards: [phys.id], targets: [] });
    t('T93', '蛊惑无懈真牌质疑', g.players[1].hp === 3 && g.discardPile.some((c) => c.id === phys.id) && g.logs.some((e) => /只能在响应时使用/.test(e.text)),
      '真牌红桃被质疑：甲hp=' + g.players[1].hp + '（应3，扣1），牌进弃牌堆=' + g.discardPile.some((c) => c.id === phys.id) + '，红桃仍结算(无效果日志)');
  }

  // T94 蛊惑声明【五谷丰登】真牌非红桃被质疑：质疑者失1体力，但不结算
  {
    const g = game([{ name: '于吉', skills: ['guhuo'], hp: 3, maxHp: 3 }, { name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    const phys = C('wugu', 'spade', 7);
    p.hand = [phys];
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3), C('tao', 'heart', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /声明一张牌/.test(req.reason || '')) return 'wugu';
      if (req.type === 'chooseOption' && /是否质疑/.test(req.reason || '')) return pl.seat === 1 ? 'yes' : 'no';
      if (req.type === 'pickFrom') return (req.cards[0] || {}).id;
      return null;
    };
    await g.useSkillAction(p, { skill: 'guhuo', cards: [phys.id], targets: [] });
    const resolved = /【五谷丰登】亮出/.test(g.logs.map((e) => e.text).join('|'));
    t('T94', '蛊惑五谷真非红桃', g.players[1].hp === 3 && !resolved && g.players[2].hand.length === 0,
      '真牌非红桃被质疑：甲hp=' + g.players[1].hp + '（应3），五谷未结算=' + !resolved + '，乙未得牌=' + (g.players[2].hand.length === 0));
  }

  // T95 蛊惑声明【酒】假牌被质疑：质疑者摸1，酒不生效
  {
    const g = game([{ name: '于吉', skills: ['guhuo'], hp: 3, maxHp: 3 }, { name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    const phys = C('sha', 'spade', 7);
    p.hand = [phys];
    g.deck = [C('tao', 'heart', 2)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /声明一张牌/.test(req.reason || '')) return 'jiu';
      if (req.type === 'chooseOption' && /是否质疑/.test(req.reason || '')) return pl.seat === 1 ? 'yes' : 'no';
      return null;
    };
    await g.useSkillAction(p, { skill: 'guhuo', cards: [phys.id], targets: [] });
    t('T95', '蛊惑酒假牌质疑', g.players[1].hand.length === 1 && !p.drank && g.discardPile.some((c) => c.id === phys.id),
      '假牌被质疑：甲手牌=' + g.players[1].hand.length + '（应1，摸1），于吉酒状态=' + (p.drank || 0) + '（应0），牌进弃牌堆=' + g.discardPile.some((c) => c.id === phys.id));
  }

  // T96 蛊惑声明【五谷丰登】真牌无人质疑：正常结算
  {
    const g = game([{ name: '于吉', skills: ['guhuo'], hp: 3, maxHp: 3 }, { name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    const phys = C('wugu', 'heart', 7);
    p.hand = [phys];
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3), C('tao', 'heart', 4), C('shan', 'diamond', 5), C('tao', 'heart', 6)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /声明一张牌/.test(req.reason || '')) return 'wugu';
      if (req.type === 'chooseOption' && /是否质疑/.test(req.reason || '')) return 'no';
      if (req.type === 'pickFrom') return (req.cards[0] || {}).id;
      return null;
    };
    await g.useSkillAction(p, { skill: 'guhuo', cards: [phys.id], targets: [] });
    const hands = g.players.map((q) => q.hand.length);
    t('T96', '蛊惑五谷无人质疑', hands.every((n) => n === 1) && g.logs.some((e) => /五谷丰登/.test(e.text)),
      '无人质疑：三人手牌=' + JSON.stringify(hands) + '（应各1），五谷日志=' + g.logs.some((e) => /五谷丰登/.test(e.text)));
  }

  // T97 化身：从化身牌技能中选一个（2 选 1）
  {
    const g = game([{ name: '左慈', skills: ['huashen', 'xinsheng'], hp: 3, maxHp: 3 }]);
    const p = g.players[0];
    p.marks.huashen = { options: [{ general: { id: 991, name: '测试武将', hp: 4, kingdom: '蜀', gender: 'male', skills: ['rende', 'jijiang'], pack: 'x' }, skill: null }], active: 0 };
    let cands = null;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /选择获得/.test(req.reason || '')) { cands = (req.options || []).map((o) => o.id); return 'jijiang'; }
      return null;
    };
    await g.ensureHuashenSkill(p);
    const added = p.skills.filter((s2) => !['huashen', 'xinsheng'].includes(s2));
    t('T97', '化身自选一个技能', Array.isArray(cands) && cands.length === 2 && added.length === 1 && added[0] === 'jijiang',
      '技能候选=' + JSON.stringify(cands) + '（应2项），获得技能=' + JSON.stringify(added) + '（应只 jijiang）');
  }

  // T98 化身替换：移除旧技能、获得新技能
  {
    const g = game([{ name: '左慈', skills: ['huashen', 'xinsheng'], hp: 3, maxHp: 3 }]);
    const p = g.players[0];
    const A = { id: 992, name: 'A', hp: 4, kingdom: '蜀', gender: 'male', skills: ['rende'], pack: 'x' };
    const B = { id: 993, name: 'B', hp: 4, kingdom: '蜀', gender: 'male', skills: ['jijiang'], pack: 'x' };
    p.marks.huashen = { options: [{ general: A, skill: null }, { general: B, skill: null }], active: 0 };
    await g.applyHuashen(p, 0);
    const afterA = p.skills.includes('rende');
    await g.applyHuashen(p, 1);
    t('T98', '化身替换技能', afterA && !p.skills.includes('rende') && p.skills.includes('jijiang') && p.marks.huashen.active === 1,
      '首个化身获得rende=' + afterA + '；替换后 rende移除=' + !p.skills.includes('rende') + '，jijiang获得=' + p.skills.includes('jijiang'));
  }

  // T99 新生：加入化身池但不预授予技能
  {
    const g = game([{ name: '左慈', skills: ['huashen', 'xinsheng'], hp: 3, maxHp: 3 }]);
    const p = g.players[0];
    const A = { id: 994, name: 'A', hp: 4, kingdom: '蜀', gender: 'male', skills: ['rende'], pack: 'x' };
    const B = { id: 995, name: 'B', hp: 4, kingdom: '蜀', gender: 'male', skills: ['jijiang'], pack: 'x' };
    p.marks.huashen = { options: [{ general: A, skill: null }, { general: B, skill: null }], active: 0 };
    await g.skillAfterDamage(p, { source: null, amount: 1 });
    const h = p.marks.huashen;
    const newOpt = h.options[2];
    t('T99', '新生加入化身池', h.options.length === 3 && !!newOpt && newOpt.skill === null,
      '新生后化身池=' + h.options.length + '（应3），新牌未预授予技能=' + (!!newOpt && newOpt.skill === null));
  }

  // T100 化身获得觉醒技后可触发（魂姿）
  {
    const g = game([{ name: '左慈', skills: ['huashen', 'xinsheng'], hp: 3, maxHp: 3 }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    p.hp = 1;
    p.marks.huashen = { options: [{ general: { id: 996, name: '孙策', hp: 4, kingdom: '吴', gender: 'male', skills: ['jiang', 'hunzi', 'zhiba'], pack: 'x' }, skill: null }], active: 0 };
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /选择获得.*技能/.test(req.reason || '')) return 'hunzi';
      if (req.type === 'chooseOption') return 'no';
      return null;
    };
    await g.skillPhaseStart(p);
    t('T100', '化身觉醒技联动', p.skills.includes('hunzi') && p.once.hunzi === true && p.skills.includes('yingzi') && p.skills.includes('yinghun') && p.maxHp === 2,
      '化身获得hunzi=' + p.skills.includes('hunzi') + '，魂姿触发=' + !!p.once.hunzi + '，获得英姿/英魂=' + (p.skills.includes('yingzi') && p.skills.includes('yinghun')) + '，maxHp=' + p.maxHp + '（应2）');
  }

  // T102 节命/遗计按每点伤害触发
  {
    const g = game([{ name: '荀彧', skills: ['jieming'], hp: 4 }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    let asks = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /节命/.test(req.reason || '')) { asks++; return 'yes'; }
      if (req.type === 'chooseTargets' && /节命/.test(req.reason || '')) return [0];
      return null;
    };
    await g.damage({ source: g.players[1], target: p, amount: 2, nature: 'normal' });
    t('T102', '节命按每点伤害触发', asks === 2, '受2点伤害，节命询问次数=' + asks + '（应2）');
  }

  // T101 askForSha 保留火杀/雷杀属性
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    const fire = C('huosha', 'heart', 10);
    const thunder = C('leisha', 'spade', 9);
    p.hand = [fire, thunder];
    g.handler = async (pl, req) => {
      if (req.type === 'response' && req.need === 'sha') return { cardId: fire.id, as: 'huosha' };
      return null;
    };
    const r1 = await g.askForSha(p, { reason: 'test' });
    g.handler = async (pl, req) => {
      if (req.type === 'response' && req.need === 'sha') return { cardId: thunder.id, as: 'leisha' };
      return null;
    };
    const r2 = await g.askForSha(p, { reason: 'test' });
    t('T101', 'askForSha 保留属性', !!r1 && r1.name === 'huosha' && r1.nature === 'fire' && !!r2 && r2.name === 'leisha' && r2.nature === 'thunder',
      '火杀返回=' + JSON.stringify(r1) + '，雷杀返回=' + JSON.stringify(r2));
  }


  // ================= 第六批：斗地主专用牌（6100-6105） =================
  // T103 斗地主专属牌堆：108 张，含炸弹/继往/攻守/进退，不影响 8p
  {
    const g = new SGS.Game({ mode: 'ddz', seed: 1, humanSeat: -1, onUpdate() {} });
    g.setup(); g.buildDeck();
    const cnt = (n) => g.deck.filter((c) => c.name === n).length;
    const uniq = new Set(g.deck.map((c) => c.id)).size;
    const special = ['zhadan', 'jiwangkailai', 'gongshoujianbei', 'jintuiziru'].every((n) => cnt(n) === 2);
    const noDelayed = cnt('lebu') === 0 && cnt('bingliang') === 0;
    const g8 = new SGS.Game({ mode: '8p', seed: 1, humanSeat: -1, onUpdate() {} });
    g8.setup(); g8.buildDeck();
    const isolated = g8.deck.length === 160 && g8.deck.every((c) => c.name !== 'zhadan' && c.name !== 'diqi');
    t('T103', '斗地主专属牌堆', g.deck.length === 108 && uniq === 108 && cnt('sha') === 29 && cnt('shan') === 16 && cnt('tao') === 8 && special && noDelayed && isolated,
      '牌堆=' + g.deck.length + '(108)，去重=' + uniq + '，杀=' + cnt('sha') + '(29) 闪=' + cnt('shan') + '(16) 桃=' + cnt('tao') + '(8)；炸弹/继往/攻守/进退各2=' + special + '；无延时锦囊=' + noDelayed + '；8p仍160且无专属牌=' + isolated);
  }

  // T104 炸弹：抵消敌方锦囊、底价加倍、且不再询问无懈
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [] }, { name: '农民B', role: 'farmer', skills: [] }], { mode: 'ddz' });
    const src = g.players[0], farmer = g.players[1];
    const wsp = C('wuzhong', 'heart', 7);
    farmer.hand = [C('zhadan', 'spade', 1)];
    g.handler = async (pl, req) => { if (req.type === 'chooseOption' && /炸弹/.test(req.reason || '')) return 'yes'; return null; };
    const vc = { id: wsp.id, name: 'wuzhong', type: 'trick', suit: 'heart', rank: 7, color: 'red', cards: [wsp] };
    const neg = await g.isNullified(vc, src, src);
    const wuxieAsked = g._asks.some((r) => r.need === 'wuxie');
    t('T104', '炸弹抵消锦囊', neg === true && farmer.hand.length === 0 && g.ddzMultiplier === 2 && !wuxieAsked,
      '被抵消=' + neg + '（应true），农民手牌=' + farmer.hand.length + '（炸弹已用，应0），倍率=' + g.ddzMultiplier + '（应2），询问无懈=' + wuxieAsked + '（应false）');
  }

  // T105 炸弹：可抵消敌方【杀】，且倍率封顶
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [] }, { name: '农民B', role: 'farmer', skills: [] }], { mode: 'ddz' });
    const src = g.players[0], farmer = g.players[1];
    farmer.hand = [C('zhadan', 'spade', 1)];
    g.handler = async (pl, req) => { if (req.type === 'chooseOption' && /炸弹/.test(req.reason || '')) return 'yes'; return null; };
    const sha = C('sha', 'spade', 7);
    await g.resolveSlash(src, { id: sha.id, name: 'sha', type: 'basic', nature: 'normal', suit: 'spade', rank: 7, color: 'black', cards: [sha] }, [farmer]);
    const hpAfter = farmer.hp;
    // 上限封顶：倍率已达上限再用炸弹不再增加
    g.ddzMultiplier = 4;
    const farmer2 = g.players[2];
    farmer2.hand = [C('zhadan', 'heart', 1)];
    const neg2 = await g.isNullified({ id: 99999, name: 'guohe', type: 'trick', suit: 'club', rank: 3, color: 'black', cards: [] }, src, src);
    t('T105', '炸弹抵消杀与上限', hpAfter === 4 && g.ddzMultiplier === 4 && neg2 === true,
      '杀被抵消后hp=' + hpAfter + '（应4），倍率封顶=' + g.ddzMultiplier + '（应4），二次炸弹=' + neg2);
  }

  // T106 地契：地主开局自动置入防具栏
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [] }, { name: '农民B', role: 'farmer', skills: [] }], { mode: 'ddz' });
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3)];
    let asked = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption') { asked++; return req.options.some((o) => o.id === 'call') ? 'call' : 'pass'; }
      return null;
    };
    await g.ddzAuction();
    const lord = g.players.find((p) => p.role === 'landlord');
    t('T106', '地契开局置入地主防具', !!lord && lord.equips.armor && lord.equips.armor.name === 'diqi',
      '地主=' + (lord && lord.nameOf ? lord.nameOf : (lord && lord.name)) + '，防具=' + (lord && lord.equips.armor && lord.equips.armor.name) + '（应diqi）');
  }

  // T107 地契：受伤可弃置防止伤害（离装销毁）
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民', role: 'farmer', skills: [] }], { mode: 'ddz' });
    const lord = g.players[0];
    const diqi = g.makeCard('diqi', 'club', 13, 9001);
    lord.equips.armor = diqi;
    g.handler = async (pl, req) => (req.type === 'chooseOption' && /地契/.test(req.reason || '') ? 'yes' : null);
    await g.damage({ source: g.players[1], target: lord, amount: 1 });
    t('T107', '地契防止伤害并销毁', lord.hp === 4 && lord.equips.armor === null && !g.discardPile.some((c) => c.id === 9001),
      '地主hp=' + lord.hp + '（应4），防具=' + lord.equips.armor + '（应null），弃牌堆含地契=' + g.discardPile.some((c) => c.id === 9001) + '（应false，销毁）');
  }

  // T108 地契：被替换/离开防具栏时销毁，不进弃牌堆
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民', role: 'farmer', skills: [] }], { mode: 'ddz' });
    const lord = g.players[0];
    const diqi = g.makeCard('diqi', 'club', 13, 9002);
    lord.equips.armor = diqi;
    g.installEquip(lord, C('bagua', 'spade', 2));
    t('T108', '地契离装销毁', lord.equips.armor && lord.equips.armor.name === 'bagua' && !g.discardPile.some((c) => c.id === 9002) && !lord.hand.some((c) => c.id === 9002),
      '新防具=' + (lord.equips.armor && lord.equips.armor.name) + '（应bagua），弃牌堆含地契=' + g.discardPile.some((c) => c.id === 9002) + '（应false），手牌含地契=' + lord.hand.some((c) => c.id === 9002));
  }

  // T109 攻守兼备：当【万箭齐发】结算
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }, { name: '丙', skills: [] }], { mode: 'ddz' });
    const p = g.players[0];
    p.role = 'landlord'; g.players[1].role = 'farmer'; g.players[2].role = 'farmer';
    const card = C('gongshoujianbei', 'spade', 10);
    p.hand = [card];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /攻守兼备/.test(req.reason || '')) return 'wanjian';
      if (req.type === 'response') return null; // 不出闪
      return null;
    };
    await g.useVirtualCard(p, [card], 'gongshoujianbei', null, [], {});
    t('T109', '攻守兼备当万箭', g.players[1].hp === 3 && g.players[2].hp === 3,
      '乙hp=' + g.players[1].hp + '（应3），丙hp=' + g.players[2].hp + '（应3）');
  }

  // T110 进退自如：当【五谷丰登】结算
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }, { name: '丙', skills: [] }], { mode: 'ddz' });
    const p = g.players[0];
    const card = C('jintuiziru', 'club', 4);
    p.hand = [card];
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3), C('tao', 'heart', 4), C('shan', 'diamond', 5), C('tao', 'heart', 6)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /进退自如/.test(req.reason || '')) return 'wugu';
      if (req.type === 'pickFrom') return (req.cards[0] || {}).id;
      return null;
    };
    await g.useVirtualCard(p, [card], 'jintuiziru', null, [], {});
    const hands = g.players.map((q) => q.hand.length);
    t('T110', '进退自如当五谷', hands.every((n) => n === 1),
      '三人手牌=' + JSON.stringify(hands) + '（应各1）');
  }

  // T111 继往开来：弃置所有手牌摸等量
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }], { mode: 'ddz' });
    const p = g.players[0];
    const jw = C('jiwangkailai', 'spade', 6);
    const s1 = C('sha', 'spade', 2), s2 = C('tao', 'heart', 3);
    p.hand = [jw, s1, s2];
    g.deck = [C('sha', 'club', 4), C('shan', 'heart', 5)];
    await g.useVirtualCard(p, [jw], 'jiwangkailai', null, [], {});
    t('T111', '继往开来弃手摸等量', p.hand.length === 2 && !p.hand.some((c) => c.id === s1.id) && !p.hand.some((c) => c.id === s2.id) && g.discardPile.some((c) => c.id === s1.id) && g.discardPile.some((c) => c.id === s2.id),
      '手牌=' + p.hand.length + '（应2），原两张已弃=' + (!p.hand.some((c) => c.id === s1.id) && !p.hand.some((c) => c.id === s2.id)));
  }


  // ================= 第七批：斗地主农民技能 聚众/共济 =================
  // T112 地主无技能，两名农民获得【聚众】【共济】
  {
    const g = game([{ name: 'P0', role: 'farmer', skills: [] }, { name: 'P1', role: 'farmer', skills: [] }, { name: 'P2', role: 'farmer', skills: [] }], { mode: 'ddz' });
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3)];
    g.handler = async (pl, req) => { if (req.type === 'chooseOption') return req.options.some((o) => o.id === 'call') ? 'call' : 'pass'; return null; };
    await g.ddzAuction();
    const lord = g.players.find((p) => p.role === 'landlord');
    const farmers = g.players.filter((p) => p.role === 'farmer');
    const farmersOk = farmers.length === 2 && farmers.every((p) => p.skills.includes('juzhong') && p.skills.includes('gongji'));
    const lordOk = lord && !lord.skills.includes('juzhong') && !lord.skills.includes('gongji');
    t('T112', '斗地主农民技能授予', farmersOk && lordOk,
      '农民技能=' + farmers.map((p) => p.skills.filter((s2) => s2 === 'juzhong' || s2 === 'gongji').join('+')).join(' / ') + '；地主有聚众/共济=' + (!!lord && lord.skills.some((s2) => s2 === 'juzhong' || s2 === 'gongji')));
  }

  // T113 聚众（杀）：队友弃同名【杀】令此杀伤害+1
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [] }, { name: '农民B', role: 'farmer', skills: ['juzhong'] }], { mode: 'ddz' });
    const L = g.players[0], A = g.players[1], B = g.players[2];
    const sha = C('sha', 'spade', 7);
    A.hand = [sha];
    B.hand = [C('sha', 'heart', 8)];
    g.handler = async (pl, req) => (req.type === 'chooseOption' && /聚众/.test(req.reason || '') ? 'yes' : null);
    await g.resolveSlash(A, { id: sha.id, name: 'sha', type: 'basic', nature: 'normal', suit: 'spade', rank: 7, color: 'black', cards: [sha] }, [L]);
    t('T113', '聚众杀伤害+1', L.hp === 2 && B.hand.length === 0,
      '地主hp=' + L.hp + '（应2），B手牌=' + B.hand.length + '（同名杀已弃，应0）');
  }

  // T114 聚众（杀）：没有同名【杀】时不触发
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [] }, { name: '农民B', role: 'farmer', skills: ['juzhong'] }], { mode: 'ddz' });
    const L = g.players[0], A = g.players[1], B = g.players[2];
    const sha = C('sha', 'spade', 7);
    A.hand = [sha];
    B.hand = [C('shan', 'heart', 8)];
    let asked = 0;
    g.handler = async (pl, req) => { if (req.type === 'chooseOption' && /聚众/.test(req.reason || '')) asked++; return 'yes'; };
    await g.resolveSlash(A, { id: sha.id, name: 'sha', type: 'basic', nature: 'normal', suit: 'spade', rank: 7, color: 'black', cards: [sha] }, [L]);
    t('T114', '聚众无同名牌不触发', L.hp === 3 && asked === 0 && B.hand.length === 1,
      '地主hp=' + L.hp + '（应3），聚众询问=' + asked + '（应0），B手牌=' + B.hand.length + '（应保留）');
  }

  // T115 聚众（闪）：队友实际【闪】生效后弃一名角色一张牌
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [] }, { name: '农民B', role: 'farmer', skills: ['juzhong'] }], { mode: 'ddz' });
    const L = g.players[0], A = g.players[1], B = g.players[2];
    const shanA = C('shan', 'diamond', 2);
    A.hand = [shanA];
    B.hand = [C('shan', 'club', 3)];
    L.hand = [C('tao', 'heart', 4), C('sha', 'spade', 5)];
    g.handler = async (pl, req) => {
      if (req.type === 'response' && req.need === 'shan' && pl.seat === A.seat) return { cardId: shanA.id };
      if (req.type === 'chooseOption' && /聚众/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseTargets' && /聚众/.test(req.reason || '')) return [L.seat];
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      return null;
    };
    const sha = C('sha', 'spade', 9);
    await g.resolveSlash(L, { id: sha.id, name: 'sha', type: 'basic', nature: 'normal', suit: 'spade', rank: 9, color: 'black', cards: [sha] }, [A]);
    t('T115', '聚众闪弃牌', A.hp === 4 && B.hand.length === 0 && L.hand.length === 1,
      'A hp=' + A.hp + '（闪生效应4），B手牌=' + B.hand.length + '（同名闪已弃，应0），地主手牌=' + L.hand.length + '（被弃1，应1）');
  }

  // T116 聚众（桃）：桃生效后使用者摸两张
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [], hp: 3 }, { name: '农民B', role: 'farmer', skills: ['juzhong'] }], { mode: 'ddz' });
    const A = g.players[1], B = g.players[2];
    const tao = C('tao', 'heart', 4);
    A.hand = [tao];
    B.hand = [C('tao', 'heart', 5)];
    g.deck = [C('sha', 'spade', 6), C('sha', 'club', 7)];
    g.handler = async (pl, req) => (req.type === 'chooseOption' && /聚众/.test(req.reason || '') ? 'yes' : null);
    await g.useVirtualCard(A, [tao], 'tao', null, [A], {});
    t('T116', '聚众桃摸两张', A.hp === 4 && A.hand.length === 2 && B.hand.length === 0,
      'A hp=' + A.hp + '（应4），A手牌=' + A.hand.length + '（摸2，应2），B手牌=' + B.hand.length + '（同名桃已弃，应0）');
  }

  // T117 聚众（酒）：弃同名【酒】令下一张【杀】伤害额外+1
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [] }, { name: '农民B', role: 'farmer', skills: ['juzhong'] }], { mode: 'ddz' });
    const L = g.players[0], A = g.players[1], B = g.players[2];
    const jiu = C('jiu', 'spade', 3), sha = C('sha', 'spade', 7);
    A.hand = [jiu, sha];
    B.hand = [C('jiu', 'club', 4)];
    g.handler = async (pl, req) => (req.type === 'chooseOption' && /聚众/.test(req.reason || '') ? 'yes' : null);
    await g.useVirtualCard(A, [jiu], 'jiu', null, [A], {});
    await g.resolveSlash(A, { id: sha.id, name: 'sha', type: 'basic', nature: 'normal', suit: 'spade', rank: 7, color: 'black', cards: [sha] }, [L]);
    t('T117', '聚众酒强化杀', L.hp === 1 && B.hand.length === 0,
      '地主hp=' + L.hp + '（酒1+酒强化1+基础1=3伤害，应1），B手牌=' + B.hand.length + '（同名酒已弃，应0）');
  }

  // T118 共济：队友受伤前弃一张牌转移伤害，限定一次
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [] }, { name: '农民B', role: 'farmer', skills: ['gongji'] }], { mode: 'ddz' });
    const L = g.players[0], A = g.players[1], B = g.players[2];
    B.hand = [C('shan', 'heart', 2)];
    let asked = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /共济/.test(req.reason || '')) { asked++; return 'yes'; }
      if (req.type === 'chooseCards' && /共济/.test(req.reason || '')) return [req.cards[0].id];
      return null;
    };
    await g.damage({ source: L, target: A, amount: 1 });
    const first = { aHp: A.hp, bHp: B.hp, once: !!B.once.gongji, asked };
    await g.damage({ source: L, target: A, amount: 1 });
    t('T118', '共济转移与限定一次', first.aHp === 4 && first.bHp === 3 && first.once === true && asked === 1 && A.hp === 3,
      '第一次：A hp=' + first.aHp + '（应4），B hp=' + first.bHp + '（应3），once=' + first.once + '，询问=' + first.asked + '（应1）；第二次 A hp=' + A.hp + '（应3，不再转移）');
  }


  // T119 聚众（酒·濒死当桃）：弃同名【酒】令回复量 +1
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [], hp: 4 }, { name: '农民B', role: 'farmer', skills: ['juzhong'] }], { mode: 'ddz' });
    const L = g.players[0], A = g.players[1], B = g.players[2];
    const jiuA = C('jiu', 'spade', 3);
    A.hp = 0; A.hand = [jiuA];
    B.hand = [C('jiu', 'club', 4)];
    g.handler = async (pl, req) => {
      if (req.need === 'tao') return { cardId: jiuA.id, as: 'tao', skill: 'jiu' };
      if (req.type === 'chooseOption' && /聚众/.test(req.reason || '')) return 'yes';
      return null;
    };
    await g.dying(A, L);
    t('T119', '聚众酒濒死回复+1', A.alive === true && A.hp === 2 && B.hand.length === 0,
      'A hp=' + A.hp + '（酒当桃1+聚众1=2，应2），B手牌=' + B.hand.length + '（同名酒已弃，应0）');
  }

  // T120 聚众（桃·濒死）：救回后使用者摸两张
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [], hp: 4 }, { name: '农民B', role: 'farmer', skills: ['juzhong'] }], { mode: 'ddz' });
    const L = g.players[0], A = g.players[1], B = g.players[2];
    const taoA = C('tao', 'heart', 4);
    A.hp = 0; A.hand = [taoA];
    B.hand = [C('tao', 'heart', 5)];
    g.deck = [C('sha', 'spade', 6), C('sha', 'club', 7)];
    g.handler = async (pl, req) => {
      if (req.need === 'tao') return { cardId: taoA.id, as: 'tao' };
      if (req.type === 'chooseOption' && /聚众/.test(req.reason || '')) return 'yes';
      return null;
    };
    await g.dying(A, L);
    t('T120', '聚众桃濒死摸两张', A.alive === true && A.hp === 1 && A.hand.length === 2 && B.hand.length === 0,
      'A hp=' + A.hp + '（应1），A手牌=' + A.hand.length + '（救回后摸2，应2），B手牌=' + B.hand.length + '（同名桃已弃，应0）');
  }


  // ================= 第八批：斗地主模式级规则 =================
  // T121 地主初始体力固定为 4（不随武将体力 +2）
  {
    const g = game([{ name: 'P0', role: 'farmer', skills: [], maxHp: 3 }, { name: 'P1', role: 'farmer', skills: [] }, { name: 'P2', role: 'farmer', skills: [] }], { mode: 'ddz' });
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3)];
    g.handler = async (pl, req) => { if (req.type === 'chooseOption') return req.options.some((o) => o.id === 'call') ? 'call' : 'pass'; return null; };
    await g.ddzAuction();
    const lord = g.players.find((p) => p.role === 'landlord');
    t('T121', '地主初始体力固定4', !!lord && lord.maxHp === 4 && lord.hp === 4,
      '地主 maxHp=' + (lord && lord.maxHp) + '（应4），hp=' + (lord && lord.hp) + '（应4，原武将3体力也固定4）');
  }

  // T122 场次倍率上限：基础场2 / 高级场4 / 练兵场2
  {
    const mk = (scene) => new SGS.Game({ mode: 'ddz', seed: 1, humanSeat: -1, ddzScene: scene, onUpdate() {} });
    const out = {};
    for (const s2 of ['basic', 'advanced', 'practice']) {
      const g = mk(s2);
      g.ddzMultiplier = 1;
      g.doubleDdzBase(); const m1 = g.ddzMultiplier;
      g.doubleDdzBase(); g.doubleDdzBase(); const m2 = g.ddzMultiplier;
      out[s2] = [g.ddzMaxMultiple, m1, m2];
    }
    t('T122', '斗地主场次倍率上限', out.basic.join() === '2,2,2' && out.advanced.join() === '4,2,4' && out.practice.join() === '2,2,2',
      '基础场=' + JSON.stringify(out.basic) + '（上限2），高级场=' + JSON.stringify(out.advanced) + '（上限4），练兵场=' + JSON.stringify(out.practice) + '（上限2）');
  }

  // T123 第 11 轮进入鏖战
  {
    const g = game([{ name: 'P0', role: 'farmer', skills: [] }, { name: 'P1', role: 'farmer', skills: [] }, { name: 'P2', role: 'landlord', skills: [] }], { mode: 'ddz' });
    g.turnCount = 30; // 3 人：第 10 轮
    const r10 = g.ddzRound, f10 = g.ddzFierce;
    g.turnCount = 31; // 第 11 轮
    const r11 = g.ddzRound, f11 = g.ddzFierce;
    const g8 = game([{ name: 'A', skills: [] }, { name: 'B', skills: [] }], { mode: '8p' });
    g8.turnCount = 99;
    t('T123', '第11轮鏖战', r10 === 10 && f10 === false && r11 === 11 && f11 === true && g8.ddzFierce === false,
      'turn30→轮' + r10 + '/fierce=' + f10 + '（应10/false）；turn31→轮' + r11 + '/fierce=' + f11 + '（应11/true）；8p fierce=' + g8.ddzFierce);
  }

  // T124 鏖战：桃不能当【桃】（不能用于濒死求桃）
  {
    const g = game([{ name: 'P0', role: 'farmer', skills: [] }, { name: 'P1', role: 'farmer', skills: [] }, { name: 'P2', role: 'landlord', skills: [] }], { mode: 'ddz' });
    const healer = g.players[1], dying = g.players[0];
    const tao = C('tao', 'heart', 3);
    healer.hand = [tao];
    g.handler = async (pl, req) => (req.need === 'tao' ? { cardId: tao.id, as: 'tao' } : null);
    g.turnCount = 1;
    const normal = await g.askForPeach(healer, dying);
    g.turnCount = 31;
    const fierce = await g.askForPeach(healer, dying);
    t('T124', '鏖战桃不能当桃', normal && normal.cardId === tao.id && fierce === null,
      '非鏖战可出桃=' + !!normal + '；鏖战 askForPeach=' + JSON.stringify(fierce) + '（应null）');
  }

  // T125 鏖战：桃可当【杀】或【闪】
  {
    const g = game([{ name: 'P0', role: 'farmer', skills: [] }, { name: 'P1', role: 'farmer', skills: [] }, { name: 'P2', role: 'landlord', skills: [] }], { mode: 'ddz' });
    const p = g.players[1];
    const tao = C('tao', 'heart', 3);
    p.hand = [tao];
    g.turnCount = 1;
    const actsNormal = g.buildPlayActions(p);
    const shanNormal = g.shanOptions(p).some((o) => o.cardId === tao.id && o.as === 'shan');
    g.turnCount = 31;
    const actsFierce = g.buildPlayActions(p);
    const asSha = actsFierce.some((a) => a.kind === 'card' && a.as === 'sha' && (a.subcards || []).includes(tao.id));
    const noTao = !actsFierce.some((a) => a.kind === 'card' && a.as === 'tao');
    const shanFierce = g.shanOptions(p).some((o) => o.cardId === tao.id && o.as === 'shan');
    const shaFierce = g.shaOptions(p).some((o) => o.cardId === tao.id && o.as === 'sha');
    t('T125', '鏖战桃当杀闪', !actsNormal.some((a) => a.as === 'sha' && (a.subcards || []).includes(tao.id)) && !shanNormal && asSha && noTao && shanFierce && shaFierce,
      '非鏖战桃当杀=' + actsNormal.some((a) => a.as === 'sha') + '/当闪=' + shanNormal + '（应false）；鏖战桃当杀=' + asSha + '，无桃动作=' + noTao + '，可当闪=' + shanFierce + '，可当杀响应=' + shaFierce);
  }

  // T126 农民互看手牌（引擎判定）
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农A', role: 'farmer', skills: [] }, { name: '农B', role: 'farmer', skills: [] }], { mode: 'ddz' });
    const L = g.players[0], A = g.players[1], B = g.players[2];
    const g8 = game([{ name: 'A', skills: [] }, { name: 'B', skills: [] }], { mode: '8p' });
    t('T126', '农民互看手牌', g.canSeeHand(A, B) === true && g.canSeeHand(B, A) === true && g.canSeeHand(A, L) === false && g.canSeeHand(L, A) === false && g8.canSeeHand(g8.players[0], g8.players[1]) === false,
      '农A看农B=' + g.canSeeHand(A, B) + '，农B看农A=' + g.canSeeHand(B, A) + '，农看地主=' + g.canSeeHand(A, L) + '，地看农=' + g.canSeeHand(L, A) + '，8p=' + g8.canSeeHand(g8.players[0], g8.players[1]));
  }


  // T127 鏖战：桃当【杀】时不可聚众
  {
    const g = game([{ name: '地主', role: 'landlord', skills: [] }, { name: '农民A', role: 'farmer', skills: [] }, { name: '农民B', role: 'farmer', skills: ['juzhong'] }], { mode: 'ddz' });
    const L = g.players[0], A = g.players[1], B = g.players[2];
    const tao = C('tao', 'heart', 3);
    A.hand = [tao];
    B.hand = [C('sha', 'spade', 4)];
    g.turnCount = 31;
    let asked = 0;
    g.handler = async (pl, req) => { if (req.type === 'chooseOption' && /聚众/.test(req.reason || '')) { asked++; return 'yes'; } return null; };
    await g.resolveSlash(A, { id: tao.id, name: 'sha', type: 'basic', nature: 'normal', suit: 'heart', rank: 3, color: 'red', cards: [tao] }, [L]);
    t('T127', '鏖战桃当杀不可聚众', asked === 0 && B.hand.length === 1 && L.hp === 3,
      '聚众询问=' + asked + '（应0），B手牌=' + B.hand.length + '（应保留），地主hp=' + L.hp + '（应3）');
  }


  // ================= 第九批：地主双将 =================
  // 公共构造：座位0地主（handler 只让 0 号叫地主），第二将选郭嘉（3体力/2技能）
  const ddzDualSetup = async (secondName) => {
    const g = game([
      { name: '甄姬', role: 'farmer', skills: ['qingguo', 'luoshen'], gender: 'female' },
      { name: '甲', role: 'farmer', skills: [] },
      { name: '乙', role: 'farmer', skills: [] },
    ], { mode: 'ddz' });
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3)];
    let secondReq = null;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption') {
        if (req.options.some((o) => o.id === 'call')) return pl.seat === 0 ? 'call' : 'pass';
        return 'pass';
      }
      if (req.type === 'chooseGeneral') {
        secondReq = req;
        const idx = (req.candidates || []).findIndex((x) => x.name === secondName);
        return { index: idx >= 0 ? idx : 0 };
      }
      return null;
    };
    await g.ddzAuction();
    return { g, secondReq, lord: g.players.find((p) => p.role === 'landlord') };
  };

  // T128 地主双将：第二将技能全量合并、体力固定4、性别取第一将
  {
    const { g, secondReq, lord } = await ddzDualSetup('郭嘉');
    const names = (secondReq && secondReq.candidates || []).map((c) => c.name);
    const skills = lord.skills || [];
    const uniq = new Set(skills).size === skills.length;
    const merged = ['yiji', 'tiandu'].every((s2) => skills.includes(s2)) && skills.includes('qingguo') && skills.includes('luoshen');
    t('T128', '地主双将技能合并', !!lord.secondGeneral && lord.secondGeneral.name === '郭嘉' && lord.general.name === '甄姬' && lord.gender === 'female' && lord.maxHp === 4 && merged && uniq && names.indexOf('甄姬') < 0,
      '第二将=' + (lord.secondGeneral && lord.secondGeneral.name) + '，仍显示第一将=' + lord.general.name + '，性别=' + lord.gender + '，maxHp=' + lord.maxHp + '，技能=' + JSON.stringify(skills) + '，候选已排除甄姬=' + (names.indexOf('甄姬') < 0) + '，无重复=' + uniq);
  }

  // T129 AI 地主自动选第二将
  {
    const g = new SGS.Game({ mode: 'ddz', seed: 7, humanSeat: -1, onUpdate() {} });
    g.agents = Array.from({ length: 3 }, (_, i) => new SGS.AI(g, i, { speed: 0 }));
    await g.start();
    const lord = g.players.find((p) => p.role === 'landlord');
    const ok = !!lord && !!lord.secondGeneral && lord.secondGeneral.id !== (lord.general && lord.general.id) && (lord.secondGeneral.skills || []).every((s2) => lord.skills.includes(s2));
    t('T129', 'AI地主自动双将', ok, '地主=' + (lord && lord.general.name) + '，第二将=' + (lord && lord.secondGeneral && lord.secondGeneral.name) + '，技能已合并=' + ok);
  }

  // T130 快照/restore 保留 secondGeneral 与合并技能
  {
    const { g, lord } = await ddzDualSetup('郭嘉');
    const snap = g.snapshot();
    const g2 = new SGS.Game({ mode: 'ddz', seed: 1, humanSeat: -1, onUpdate() {} });
    g2.restore(snap);
    const lord2 = g2.players.find((p) => p.role === 'landlord');
    const sameSkills = JSON.stringify([...(lord2.skills || [])].sort()) === JSON.stringify([...(lord.skills || [])].sort());
    t('T130', '双将存档恢复', !!lord2.secondGeneral && lord2.secondGeneral.name === '郭嘉' && lord2.general.name === '甄姬' && lord2.maxHp === 4 && lord2.gender === 'female' && sameSkills,
      'restore 后 secondGeneral=' + (lord2.secondGeneral && lord2.secondGeneral.name) + '，第一将=' + lord2.general.name + '，maxHp=' + lord2.maxHp + '，技能一致=' + sameSkills);
  }

  // T131 非斗地主模式不受影响（无 secondGeneral）
  {
    const g = new SGS.Game({ mode: '8p', seed: 5, humanSeat: -1, onUpdate() {} });
    g.setup();
    await g.draft();
    const anySecond = g.players.some((p) => p.secondGeneral);
    t('T131', '双将仅斗地主', g.ddzMode === false && !anySecond, '8p 出现 secondGeneral=' + anySecond + '（应false）');
  }

  // T132 双将不触发第二将的主公技（地主不是 lord 身份）
  {
    const { g, lord } = await ddzDualSetup('刘备');
    const acts = g.buildPlayActions(lord);
    const jijiangAct = acts.some((a) => a.skill === 'jijiang');
    t('T132', '双将不触发主公技', (lord.skills || []).includes('jijiang') && !jijiangAct && lord.role === 'landlord',
      '第二将刘备技能含jijiang=' + (lord.skills || []).includes('jijiang') + '，出牌动作含激将=' + jijiangAct + '（应false），role=' + lord.role);
  }


  // ================= 第十批：神速/巧变阶段时机 =================
  // T133 神速①：判定阶段开始时发动（准备阶段不再触发），跳过判定+摸牌
  {
    const g = game([{ name: '夏侯渊', skills: ['shensu'] }, { name: '甲', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    let startAsk = 0, judgeAsk = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /神速/.test(req.reason || '')) {
        if (/神速①/.test(req.reason || '')) { judgeAsk++; return 'yes'; }
        startAsk++;
      }
      if (req.type === 'chooseTargets' && /神速/.test(req.reason || '')) return [1];
      return null;
    };
    await g.skillPhaseStart(p);
    const startAfter = startAsk;
    await g.phaseJudge(p);
    t('T133', '神速①改为判定阶段开始', startAfter === 0 && judgeAsk === 1 && p.skip.judge === true && p.skip.draw === true && p.flags.shensuUsed === true && q.hp === 3,
      '准备阶段询问=' + startAfter + '（应0），判定阶段询问=' + judgeAsk + '（应1），skip.judge/draw=' + p.skip.judge + '/' + p.skip.draw + '，甲hp=' + q.hp + '（应3）');
  }

  // T134 神速②：摸牌阶段开始时发动，弃装备+视为杀+跳过出牌，摸牌仍正常
  {
    const g = game([{ name: '夏侯渊', skills: ['shensu'] }, { name: '甲', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    const eq = C('qinglong', 'spade', 5);
    p.equips.weapon = eq;
    g.deck = [C('sha', 'spade', 2), C('sha', 'club', 3), C('sha', 'heart', 4)];
    let asked = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /神速②/.test(req.reason || '')) { asked++; return 'yes'; }
      if (req.type === 'response' && req.need === 'discardEquip') return { cardId: eq.id };
      if (req.type === 'chooseTargets' && /神速②/.test(req.reason || '')) return [1];
      return null;
    };
    await g.phaseDraw(p);
    t('T134', '神速②改为摸牌阶段开始', asked === 1 && p.equips.weapon === null && p.skip.play === true && p.flags.shensu2Used === true && q.hp === 3 && p.hand.length === 2,
      '询问=' + asked + '（应1），武器=' + p.equips.weapon + '（应null），skip.play=' + p.skip.play + '，甲hp=' + q.hp + '，摸牌后手牌=' + p.hand.length + '（应2）');
  }

  // T135 神速同回合不重复：第二次判定阶段不再询问
  {
    const g = game([{ name: '夏侯渊', skills: ['shensu'] }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    let asked = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /神速①/.test(req.reason || '')) { asked++; return 'yes'; }
      if (req.type === 'chooseTargets' && /神速/.test(req.reason || '')) return [1];
      return null;
    };
    await g.skillPhaseHook(p, 'judge');
    await g.skillPhaseHook(p, 'judge');
    t('T135', '神速同回合不重复', asked === 1 && p.flags.shensuUsed === true, '两次判定阶段钩子询问次数=' + asked + '（应1），已用标记=' + p.flags.shensuUsed);
  }

  // T136 巧变：判定阶段开始弃牌跳过判定
  {
    const g = game([{ name: '张郃', skills: ['qiaobian'] }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    const c1 = C('sha', 'spade', 7), c2 = C('tao', 'heart', 2);
    p.hand = [c1, c2];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /巧变/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCards' && /巧变/.test(req.reason || '')) return [c1.id];
      return null;
    };
    await g.phaseJudge(p);
    t('T136', '巧变跳过判定', p.skip.judge === true && p.flags.qiaobian === true && p.hand.length === 1 && g.discardPile.some((c) => c.id === c1.id),
      'skip.judge=' + p.skip.judge + '，flags=' + p.flags.qiaobian + '，手牌=' + p.hand.length + '（应1），弃牌堆含所选=' + g.discardPile.some((c) => c.id === c1.id));
  }

  // T137 巧变：摸牌阶段跳过并至多获得两名角色各一张手牌
  {
    const g = game([{ name: '张郃', skills: ['qiaobian'] }, { name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0], a = g.players[1], b = g.players[2];
    p.hand = [C('sha', 'spade', 7), C('tao', 'heart', 2)];
    a.hand = [C('sha', 'club', 3)];
    b.hand = [C('shan', 'diamond', 4)];
    let asked = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /巧变/.test(req.reason || '')) { asked++; return 'yes'; }
      if (req.type === 'chooseCards' && /巧变/.test(req.reason || '')) return [p.hand[0].id];
      if (req.type === 'chooseTargets' && /巧变/.test(req.reason || '')) return [1, 2];
      return null;
    };
    await g.phaseDraw(p);
    t('T137', '巧变跳过摸牌并获得手牌', asked === 1 && p.skip.draw === true && a.hand.length === 0 && b.hand.length === 0 && p.hand.length === 3,
      '询问=' + asked + '，skip.draw=' + p.skip.draw + '，甲乙手牌=' + a.hand.length + '/' + b.hand.length + '（应0/0），张郃手牌=' + p.hand.length + '（弃1得2=3）');
  }

  // T138 巧变：出牌阶段跳过并移动场上一张牌
  {
    const g = game([{ name: '张郃', skills: ['qiaobian'] }, { name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0], a = g.players[1], b = g.players[2];
    p.hand = [C('sha', 'spade', 7), C('tao', 'heart', 2)];
    const armor = C('bagua', 'spade', 2);
    a.equips.armor = armor;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /巧变/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCards' && /巧变/.test(req.reason || '')) return [p.hand[0].id];
      if (req.type === 'chooseTargets' && /选择要移动其场上牌的角色/.test(req.reason || '')) return [1];
      if (req.type === 'chooseTargets' && /选择移动到的角色/.test(req.reason || '')) return [2];
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'armor' };
      return null;
    };
    await g.phasePlay(p);
    t('T138', '巧变跳过出牌并移牌', p.skip.play === true && a.equips.armor === null && b.equips.armor && b.equips.armor.id === armor.id,
      'skip.play=' + p.skip.play + '，甲防具=' + a.equips.armor + '（应null），乙防具=' + (b.equips.armor && b.equips.armor.name) + '（应bagua）');
  }

  // T139 巧变：弃牌阶段跳过弃牌
  {
    const g = game([{ name: '张郃', skills: ['qiaobian'], hp: 1, maxHp: 4 }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    p.hand = [C('sha', 'spade', 2), C('sha', 'club', 3), C('tao', 'heart', 4), C('shan', 'diamond', 5), C('sha', 'heart', 6)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /巧变/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCards' && /巧变/.test(req.reason || '')) return [p.hand[0].id];
      return null;
    };
    await g.phaseDiscard(p);
    t('T139', '巧变跳过弃牌', p.skip.discard === true && p.hand.length === 4,
      'skip.discard=' + p.skip.discard + '，手牌=' + p.hand.length + '（弃1后4，未再弃到体力上限）');
  }

  // T140 非对应技能/模式不误触发；出牌阶段不再有神速②/巧变入口
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g.handler = async () => null;
    await g.phaseJudge(g.players[0]);
    const noAsk = g._asks.length === 0;
    const g2 = game([{ name: '夏侯渊', skills: ['shensu'] }, { name: '张郃', skills: ['qiaobian'] }]);
    const acts = g2.buildPlayActions(g2.players[0]).concat(g2.buildPlayActions(g2.players[1]));
    const noSkillActs = !acts.some((a) => a.skill === 'shensu2' || a.skill === 'qiaobian');
    t('T140', '阶段钩子按技能/模式触发', noAsk && noSkillActs,
      '无技能判定阶段询问=' + g._asks.length + '（应0），出牌阶段神速②/巧变入口=' + !noSkillActs + '（应false）');
  }

  // T141 巧变每回合一次：跳过判定后不再询问摸牌阶段
  {
    const g = game([{ name: '张郃', skills: ['qiaobian'] }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    p.hand = [C('sha', 'spade', 7), C('tao', 'heart', 2)];
    let asked = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /巧变/.test(req.reason || '')) { asked++; return 'yes'; }
      if (req.type === 'chooseCards' && /巧变/.test(req.reason || '')) return [p.hand[0].id];
      return null;
    };
    await g.skillPhaseHook(p, 'judge');
    await g.skillPhaseHook(p, 'draw');
    t('T141', '巧变每回合一次', asked === 1 && p.skip.draw !== true,
      '询问次数=' + asked + '（应1），skip.draw=' + p.skip.draw + '（应false）');
  }

  // ================= 变体扩展包（默认关闭） =================
  // T142 数据完整性：30 名、pack=extras、技能可解析、无 id 冲突、按原版性别/体力
  {
    const ids = D.EXTRA_GENERALS.map((g) => g.id);
    const expected = [61, 108, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 318, 319, 320, 440, 441, 442, 443, 444, 445, 446];
    const idOk = ids.length === 30 && expected.every((id) => ids.includes(id));
    const packOk = D.EXTRA_GENERALS.every((g) => g.pack === 'extras' && g.variant === true);
    const skillOk = D.EXTRA_GENERALS.every((g) => g.skills.every((id) => !!D.SKILLS[id]));
    const baseOk = D.EXTRA_GENERALS.every((g) => g.baseGeneral == null || D.GENERALS.some((b) => b.id === g.baseGeneral && b.pack !== 'extras'));
    const hw = (id) => { const g = D.GENERALS.find((x) => x.id === id); return g && [g.name, g.kingdom, g.hp, g.gender].join('/'); };
    const hwOk = hw(446) === '华雄/群/6/male' && hw(108) === '赵云/群/3/male' && hw(309) === '大乔/吴/3/female' && hw(299) === '刘备/蜀/4/male';
    const noDup = new Set(D.GENERALS.map((g) => g.id)).size === D.GENERALS.length;
    t('T142', '变体扩展数据完整性', idOk && packOk && skillOk && baseOk && hwOk && noDup && D.EXTRAS_PACK.defaultEnabled === false,
      `ids=${ids.length}/30，pack=${packOk}，技能可解析=${skillOk}，baseGeneral 可解析=${baseOk}，` +
      `446=${hw(446)}，108=${hw(108)}，309=${hw(309)}，id 不重复=${noDup}，默认关闭=${!D.EXTRAS_PACK.defaultEnabled}`);
  }

  // T143 默认关闭：8p/1v1/3v3 选将池与化身池都看不到变体将
  {
    let leak = 0, total = 0;
    for (const mode of ['8p', '1v1', '3v3']) {
      for (let seed = 1; seed <= 3; seed++) {
        const g = new SGS.Game({ mode, seed, humanSeat: -1, onUpdate() {} });
        g.setup();
        const cands = g.players.reduce((a, p) => a.concat(p.candidates || []), []);
        total += cands.length;
        if (cands.some((x) => x.pack === 'extras')) leak++;
      }
    }
    // 斗地主地主双将池：默认也不含变体
    const gd = new SGS.Game({ mode: 'ddz', seed: 9, humanSeat: -1, onUpdate() {} });
    gd.players = [P({ name: '地主', role: 'landlord', skills: [] }, 0), P({ name: '甲', role: 'farmer', skills: [] }, 1), P({ name: '乙', role: 'farmer', skills: [] }, 2)];
    gd.players.forEach((p, i) => { p.general = { id: 900 + i, name: '测试' + i, kingdom: '群', gender: 'male', hp: 4, skills: [], pack: 'x' }; });
    const pool = gd.availableGenerals().filter((x) => !gd.players.some((p) => p.general.id === x.id || p.general.name === x.name));
    const ddzLeak = pool.some((x) => x.pack === 'extras');
    // 化身：未开启时池内不得出现变体
    const gh = new SGS.Game({ mode: '8p', seed: 5, humanSeat: -1, onUpdate() {} });
    gh.players = [P({ name: '左慈', skills: ['huashen'] }, 0)];
    gh.initHuashen(gh.players[0]);
    const hsLeak = gh.players[0].marks.huashen.options.some((o) => o.general.pack === 'extras');
    t('T143', '默认关闭时各模式将池无变体', leak === 0 && !ddzLeak && !hsLeak,
      `8p/1v1/3v3 共 ${total} 张候选泄漏=${leak}，地主双将池泄漏=${ddzLeak}，化身池泄漏=${hsLeak}`);
  }

  // T144 开启 extras 后进入 8p 与 3v3 将池，draft 实际可选到
  {
    const g = game([], {});
    g.packs = ['标准', '风', '火', '林', '山', 'extras'];
    g.extrasEnabled = true;
    const avail = g.availableGenerals();
    g.shuffle = (arr) => arr.slice().sort((a, b) => ((a.pack === 'extras' ? 0 : 1) - (b.pack === 'extras' ? 0 : 1)) || a.id - b.id);
    g.setup();
    const cands = g.players.reduce((a, p) => a.concat(p.candidates || []), []);
    const visible = cands.filter((x) => x.pack === 'extras').length;
    g.handler = async () => null;
    await g.draft();
    const drafted = g.players.filter((p) => p.general && p.general.pack === 'extras').length;

    const g3 = game([], {});
    g3.mode = '3v3';
    g3.packs = ['标准', '风', '火', '林', '山', 'extras'];
    g3.extrasEnabled = true;
    g3.shuffle = (arr) => arr.slice().sort((a, b) => ((a.pack === 'extras' ? 0 : 1) - (b.pack === 'extras' ? 0 : 1)) || a.id - b.id);
    g3.setup();
    const c3 = g3.players.reduce((a, p) => a.concat(p.candidates || []), []);
    const v3 = c3.filter((x) => x.pack === 'extras').length;
    t('T144', '开启 extras 后变体进入将池且可被选到', avail.filter((x) => x.pack === 'extras').length === 30 && visible > 0 && drafted > 0 && v3 > 0,
      `可用将池=${avail.length}（含变体 ${avail.filter((x) => x.pack === 'extras').length}），8p 候选含变体=${visible}，draft 选中变体人数=${drafted}，3v3 候选含变体=${v3}`);
  }

  // T145 门控 API：packs 含 extras / opts.extras / setExtras，显式 false 优先
  {
    const a = new SGS.Game({ mode: '8p', seed: 1, humanSeat: -1, packs: ['标准', 'extras'], onUpdate() {} });
    const b = new SGS.Game({ mode: '8p', seed: 1, humanSeat: -1, packs: ['标准'], extras: true, onUpdate() {} });
    const c = new SGS.Game({ mode: '8p', seed: 1, humanSeat: -1, packs: ['标准', 'extras'], extras: false, onUpdate() {} });
    const d = new SGS.Game({ mode: '8p', seed: 1, humanSeat: -1, packs: ['标准'], onUpdate() {} });
    const e = D.isExtrasEnabled(['标准', 'extras']) === true && D.isExtrasEnabled(['标准']) === false;
    d.setExtras(true);
    const f = d.extrasOn() === true && d.availableGenerals().some((x) => x.pack === 'extras');
    d.setExtras(false);
    const h = d.extrasOn() === false && !d.availableGenerals().some((x) => x.pack === 'extras');
    t('T145', '变体扩展门控 API', a.extrasOn() && b.extrasOn() && !c.extrasOn() && e && f && h,
      `packs含extras=${a.extrasOn()}，opts.extras=${b.extrasOn()}，显式false=${!c.extrasOn()}，` +
      `isExtrasEnabled=${e}，setExtras(true→false)=${f}/${h}`);
  }

  // T146 地主双将：开启 extras 时第二武将可取变体，技能去重合并
  {
    const g = game([
      { name: '地主', role: 'landlord', skills: ['rende', 'jijiang'] },
      { name: '甲', role: 'farmer', skills: [] },
      { name: '乙', role: 'farmer', skills: [] },
    ], { mode: 'ddz' });
    g.extrasEnabled = true;
    g.players[0].general = { id: 299, name: '刘备', kingdom: '蜀', gender: 'male', hp: 4, skills: ['rende', 'jijiang'], pack: 'extras' };
    g.players[1].general = { id: 2, name: '关羽', kingdom: '蜀', gender: 'male', hp: 4, skills: ['wusheng'], pack: '标准' };
    g.players[2].general = { id: 3, name: '张飞', kingdom: '蜀', gender: 'male', hp: 4, skills: ['paoxiao'], pack: '标准' };
    let pool = null;
    g.handler = async (p, req) => {
      if (req.type === 'chooseGeneral') {
        pool = req.candidates;
        const i = pool.findIndex((x) => x.id === 446);
        return { index: i };
      }
      return null;
    };
    await g.ddzPickSecondGeneral(g.players[0]);
    const lord = g.players[0];
    const sk = lord.skills;
    const merged = lord.secondGeneral && lord.secondGeneral.id === 446 && sk.includes('j_yaowu') && sk.includes('shizhan') && sk.includes('rende') && sk.includes('jijiang');
    const noDup = new Set(sk).size === sk.length;
    const poolLeak = pool ? pool.some((x) => x.pack === 'extras') : false;
    t('T146', '地主双将合并变体技能', merged && noDup && poolLeak,
      `第二武将=${lord.secondGeneral && lord.secondGeneral.name}(${lord.secondGeneral && lord.secondGeneral.pack})，技能=${sk.join(',')}，无重复=${noDup}，双将池含变体=${poolLeak}`);
  }

  // T147 存档：extras 开关写入快照并可恢复
  {
    const g = game([{ name: '甲', skills: [] }]);
    g.extrasEnabled = true;
    const snap = g.snapshot();
    const g2 = new SGS.Game({ mode: '8p', seed: 1, humanSeat: -1, onUpdate() {} });
    g2.restore(JSON.parse(JSON.stringify(snap)));
    const g3 = new SGS.Game({ mode: '8p', seed: 1, humanSeat: -1, onUpdate() {} });
    const snap3 = g3.snapshot();
    const g4 = new SGS.Game({ mode: '8p', seed: 1, humanSeat: -1, onUpdate() {} });
    g4.restore(JSON.parse(JSON.stringify(snap3)));
    t('T147', '变体扩展开关进入存档', snap.extras === true && g2.extrasOn() === true && snap3.extras === false && g4.extrasOn() === false,
      `开启快照=${snap.extras}→恢复=${g2.extrasOn()}，默认快照=${snap3.extras}→恢复=${g4.extrasOn()}`);
  }

  // T148 义从：距离 -1；体力≤2 时他人计算与你的距离 +1
  {
    const g = game([{ name: '公孙瓒', skills: ['yicong'], hp: 4 }, { name: '甲' }, { name: '乙' }, { name: '丙', skills: ['yicong'] }, { name: '丁' }]);
    const [a, b, c, d] = g.players;
    const base = g.distance(b, c); // 无技能基准：相邻 = 1
    const far = g.distance(a, c);  // 原始 2，义从 -1
    d.hp = 4;
    const healthy = g.distance(a, d); // 原始 2，义从 -1 = 1
    d.hp = 2;
    const wounded = g.distance(a, d); // 原始 2 -1(自己) +1(对方受伤) = 2
    t('T148', '义从距离修正', base === 1 && far === 1 && healthy === 1 && wounded === 2,
      `基准相邻=${base}（应1），公孙瓒对隔位=${far}（应1），对方满血=${healthy}（应1），对方体力2=${wounded}（应2）`);
  }

  // T149 趫猛：杀造成伤害后弃目标区域一张牌；坐骑牌则获得之
  {
    const g = game([{ name: '公孙瓒', skills: ['qiaomeng'], hp: 4 }, { name: '甲', hp: 4 }, { name: '乙' }]);
    const [a, b] = g.players;
    const sha = C('sha', 'spade', 7);
    a.hand = [sha];
    b.equips.offhorse = C('dilu', 'club', 5);
    const mountId = b.equips.offhorse.id;
    g.handler = async (p, req) => {
      if (req.type === 'chooseOption' && /趫猛/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'offhorse' };
      return null;
    };
    await g.damage({ source: a, target: b, amount: 1, card: sha });
    const gained = a.hand.some((x) => x.id === mountId) && b.equips.offhorse === null;
    // 非坐骑：应当弃置
    b.equips.armor = C('bagua', 'club', 2);
    const armorId = b.equips.armor.id;
    g.handler = async (p, req) => {
      if (req.type === 'chooseOption' && /趫猛/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'armor' };
      return null;
    };
    await g.damage({ source: a, target: b, amount: 1, card: sha });
    const discarded = g.discardPile.some((x) => x.id === armorId) && !a.hand.some((x) => x.id === armorId);
    t('T149', '趫猛弃牌/获得坐骑', gained && discarded,
      `获得坐骑=${gained}（${b.equips.offhorse ? '仍在原处' : '已离开装备区'}），非坐骑进弃牌堆=${discarded}`);
  }

  // T150 耀武（华雄 Po）：红色伤害牌→来源摸一张；非红→华雄摸一张
  {
    const g = game([{ name: '甲', hp: 4 }, { name: '华雄', skills: ['j_yaowu'], hp: 6 }]);
    const [a, b] = g.players;
    g.deck = [C('shan', 'diamond', 3), C('sha', 'club', 4), C('tao', 'heart', 5)];
    const a0 = a.hand.length;
    await g.damage({ source: a, target: b, amount: 1, card: C('sha', 'heart', 5) });
    const redDraw = a.hand.length === a0 + 1;
    const b0 = b.hand.length;
    await g.damage({ source: a, target: b, amount: 1, card: C('sha', 'spade', 6) });
    const blackDraw = b.hand.length === b0 + 1;
    t('T150', '耀武红色/非红摸牌', redDraw && blackDraw,
      `红色伤害牌：甲手牌 ${a0}→${a.hand.length}（应+1）；非红：华雄手牌 ${b0}→${b.hand.length}（应+1）`);
  }

  // T151 诛害：其他角色结束阶段若本回合造成过伤害，可用【杀】
  {
    const g = game([{ name: '徐庶', skills: ['zhuhai'], hp: 4 }, { name: '甲', hp: 4 }]);
    const [x, p1] = g.players;
    g.currentSeat = 1;
    const sha = C('sha', 'spade', 9);
    x.hand = [sha];
    p1.flags.dealtDamage = true;
    let asked = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /诛害/.test(req.reason || '')) { asked++; return 'yes'; }
      if (req.type === 'chooseCards' && /诛害/.test(req.reason || '')) return [sha.id];
      return null;
    };
    await g.skillEndPhase(p1);
    const hit = p1.hp === 3 && x.hand.length === 0 && asked === 1;
    // 未造成过伤害时不触发
    const g2 = game([{ name: '徐庶', skills: ['zhuhai'], hp: 4 }, { name: '甲', hp: 4 }]);
    g2.currentSeat = 1;
    g2.players[0].hand = [C('sha', 'spade', 10)];
    g2.players[1].flags.dealtDamage = false;
    let asked2 = 0;
    g2.handler = async (pl, req) => { if (/诛害/.test(req.reason || '')) asked2++; return null; };
    await g2.skillEndPhase(g2.players[1]);
    t('T151', '诛害结束阶段触发', hit && asked2 === 0,
      `造成伤害后：询问=${asked}，甲 hp=${p1.hp}（应3），徐庶手牌=${x.hand.length}（应0）；未造成伤害询问=${asked2}（应0）`);
  }

  // T152 潜心觉醒获得荐言；荐言限一次并把牌堆顶第一张符合的牌交给男性角色
  {
    const g = game([{ name: '徐庶', skills: ['zhuhai', 'qianxin'], hp: 3, maxHp: 4 }, { name: '甲', hp: 4 }]);
    const [x, t1] = g.players;
    g.currentSeat = 0;
    const sha = C('sha', 'spade', 7);
    x.hand = [sha];
    let dive = 0;
    g.handler = async (p, req) => {
      if (req.type === 'chooseOption' && /潜心/.test(req.reason || '')) { dive++; return 'yes'; }
      return null;
    };
    await g.damage({ source: x, target: t1, amount: 1, card: sha });
    const awake = x.skills.includes('jianyan') && !x.skills.includes('qianxin') && x.maxHp === 3 && dive === 1;
    // 荐言：牌堆顶（数组尾部）放一张基本牌
    const basic = C('sha', 'diamond', 6);
    g.deck = [C('guohe', 'spade', 3), basic];
    t1.hand = [];
    g.handler = async (p, req) => {
      if (req.type === 'chooseOption' && /荐言/.test(req.reason || '')) return 'basic';
      return null;
    };
    await g.useSkillAction(x, { skill: 'jianyan', targets: [1] });
    const gave = t1.hand.some((c) => c.id === basic.id);
    const acts = [];
    g.buildSkillActions(x, (a) => acts.push(a));
    const once = !acts.some((a) => a.skill === 'jianyan');
    t('T152', '潜心觉醒与荐言', awake && gave && once,
      `觉醒=${awake}（maxHp=${x.maxHp}，技能=${x.skills.join(',')}），交付基本牌=${gave}（甲手牌 ${t1.hand.length}），限一次=${once}`);
  }

  // T153 响应杀/闪/桃写入出牌事件（卡牌语音）
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    const sha = C('sha', 'spade', 7), shan = C('shan', 'heart', 2), tao = C('tao', 'heart', 3);
    p.hand = [sha];
    g.handler = async () => ({ cardId: sha.id, as: 'sha' });
    await g.askForSha(p, {});
    const shaEvent = g.recent[g.recent.length - 1];
    p.hand = [shan];
    g.handler = async () => ({ cardId: shan.id, as: 'shan' });
    await g.askForShan(p, {});
    const shanEvent = g.recent[g.recent.length - 1];
    p.hand = [tao];
    g.handler = async () => ({ cardId: tao.id, as: 'tao' });
    await g.askForPeach(p, q);
    const taoEvent = g.recent[g.recent.length - 1];
    t('T153', '响应杀/闪/桃写出牌事件',
      shaEvent && shaEvent.card === 'sha' && shanEvent && shanEvent.card === 'shan' && taoEvent && taoEvent.card === 'tao',
      'sha=' + JSON.stringify(shaEvent) + ' shan=' + JSON.stringify(shanEvent) + ' tao=' + JSON.stringify(taoEvent));
  }

  // ================= 界/Po 变体差异化技能 =================
  // T154 隔离与覆盖：j_ 技能只在 extras 变体上，基础 57 将不受影响
  {
    const jIds = ['j_rende','j_jijiang','j_wusheng','j_paoxiao','j_tishen','j_longdan','j_qinxue','gongxin','j_lianying','j_jianxiong','j_yiji','j_guicai','j_fankui','j_ganglie','j_zhiheng','j_biyue','j_guanxing','j_kurou','j_zhaxiang','j_tuxi','j_yaowu','shizhan','j_fanjian','j_yijue','j_tieji','j_yingzi','j_guose','j_luoyi','j_luoshen','j_jieyin','j_jizhi','j_qicai','j_jiuyuan','j_liyu','j_chuli'];
    const base = D.GENERALS.filter((g) => g.pack !== 'extras');
    const baseLeak = base.some((g) => g.skills.some((s) => s.startsWith('j_') || s === 'gongxin' || s === 'shizhan'));
    const defs = jIds.every((id) => D.SKILLS[id] && D.SKILLS[id].desc);
    const used = new Set(D.EXTRA_GENERALS.reduce((a, g) => a.concat(g.skills), []));
    const allUsed = jIds.filter((id) => id !== 'gongxin').every((id) => used.has(id)) && !!D.SKILLS.gongxin; // 攻心由勤学觉醒授予
    const baseSpot = [['1','rende,jijiang'],['4','guanxing,kongcheng'],['8','zhiheng,jiuyuan'],['10','keji'],['12','yingzi,fanjian'],['15','jianxiong,hujia'],['16','fankui,guicai'],['17','ganglie'],['18','tuxi'],['20','tiandu,yiji'],['22','jijiu,qingnang'],['24','lijian,biyue'],['26','liegong']]
      .every(([id, sk]) => { const g = D.GENERALS.find((x) => x.id === Number(id)); return g && g.skills.join(',') === sk; });
    t('T154', '变体技能隔离与覆盖', !baseLeak && defs && allUsed && baseSpot,
      `基础将含变体技能=${baseLeak}（应false），j_ 定义/文案=${defs}，全部被变体引用=${allUsed}，基础 13 将技能未变=${baseSpot}`);
  }

  // T155 仁德（界）：每名角色限一次；给出第二张时可视为使用基本牌
  {
    const g = game([{ name: '刘备', skills: ['j_rende'], hp: 4 }, { name: '甲', hp: 4 }, { name: '乙', hp: 4 }]);
    const p = g.players[0];
    const s1 = C('sha', 'spade', 1), s2 = C('sha', 'spade', 2), s3 = C('sha', 'spade', 3);
    p.hand = [s1, s2, s3];
    g.currentSeat = 0; g.phase = 'play';
    let basicAsks = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /仁德/.test(req.reason || '')) { basicAsks++; return 'sha'; }
      if (req.type === 'chooseTargets') return [1];
      return null;
    };
    await g.useSkillAction(p, { skill: 'j_rende', cards: [s1.id], targets: [1] });
    await g.useSkillAction(p, { skill: 'j_rende', cards: [s2.id], targets: [2] });
    const virtualHit = basicAsks === 1 && g.players[1].hp === 3;
    const onceTarget = g.players[1].hand.length === 1 && g.players[2].hand.length === 1;
    const before = p.hand.length;
    await g.useSkillAction(p, { skill: 'j_rende', cards: [p.hand[0].id], targets: [1] });
    const blocked = p.hand.length === before;
    t('T155', '仁德（界）每角色限一次+第二张基本牌', virtualHit && onceTarget && blocked,
      `第二次给牌触发基本牌=${basicAsks}，甲 hp=${g.players[1].hp}（应3），甲/乙手牌=${g.players[1].hand.length}/${g.players[2].hand.length}（应1/1），重复目标被拒=${blocked}`);
  }

  // T156 激将（界）：蜀势力角色回合外打出【杀】可令主公摸一张，每回合一次
  {
    const g = game([{ name: '主公', role: 'lord', kingdom: '蜀', skills: ['j_jijiang'], hp: 4 }, { name: '蜀将', kingdom: '蜀', skills: [], hp: 4 }, { name: '他', kingdom: '群', skills: [], hp: 4 }]);
    const lord = g.players[0], ally = g.players[1];
    g.currentSeat = 2;
    ally.hand = [C('sha', 'spade', 1), C('sha', 'club', 2)];
    g.deck = [C('shan', 'diamond', 3)];
    let asks = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'response' && req.options && req.options.length) return { cardId: req.options[0].cardId };
      if (req.type === 'chooseOption' && /激将/.test(req.reason || '')) { asks++; return 'yes'; }
      return null;
    };
    const l0 = lord.hand.length;
    await g.askForSha(ally, { reason: '测试' });
    const drew = lord.hand.length === l0 + 1 && asks === 1;
    await g.askForSha(ally, { reason: '测试' });
    const once = asks === 1 && lord.hand.length === l0 + 1;
    t('T156', '激将（界）回合外杀摸牌', drew && once,
      `第一次询问=${asks}，主公手牌 ${l0}→${lord.hand.length}（应+1）；同回合第二次不触发=${once}`);
  }

  // T157 武圣（界）：方块【杀】无距离限制
  {
    const g = game([{ name: '关羽', skills: ['j_wusheng'], hp: 4 }, { name: '甲', hp: 4 }, { name: '乙', hp: 4 }, { name: '丙', hp: 4 }]);
    const p = g.players[0];
    p.hand = [C('shan', 'diamond', 5)];
    const acts = g.buildPlayActions(p);
    const a = acts.find((x) => x.kind === 'card' && x.as === 'sha' && x.skill === 'j_wusheng');
    const dist = a && a.targetCandidates.includes(2);
    const g2 = game([{ name: '关羽', skills: ['wusheng'], hp: 4 }, { name: '甲', hp: 4 }, { name: '乙', hp: 4 }, { name: '丙', hp: 4 }]);
    g2.players[0].hand = [C('shan', 'diamond', 5)];
    const a2 = g2.buildPlayActions(g2.players[0]).find((x) => x.kind === 'card' && x.as === 'sha' && x.skill === 'wusheng');
    const baseNoDist = a2 && !a2.targetCandidates.includes(2);
    t('T157', '武圣（界）方块杀无距离', !!dist && !!baseNoDist,
      `界武圣可选隔位=${!!dist}，基础武圣不可选隔位=${!!baseNoDist}`);
  }

  // T158 咆哮（界）：杀被抵消后，本回合下一张杀伤害+1；且杀无次数限制
  {
    const g = game([{ name: '张飞', skills: ['j_paoxiao'], hp: 4 }, { name: '甲', hp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    const shan = C('shan', 'diamond', 1);
    tgt.hand = [shan];
    g.handler = async (pl, req) => (req.type === 'response' && req.need === 'shan') ? { cardId: shan.id } : null;
    await g.resolveSlash(p, { id: 201, name: 'sha', type: 'basic', suit: 'spade', rank: 2, color: 'black', cards: [] }, [tgt]);
    const dodged = tgt.hp === 4 && p.flags.paoNext === true;
    await g.resolveSlash(p, { id: 202, name: 'sha', type: 'basic', suit: 'spade', rank: 3, color: 'black', cards: [] }, [tgt]);
    const bonus = tgt.hp === 2;
    const unlimited = g.canUseSlash(p) === true && p.slashCount === 2;
    t('T158', '咆哮（界）抵消补偿与无次数', dodged && bonus && unlimited,
      `首杀被闪后标记=${dodged}，第二杀伤害=${4 - tgt.hp}（应2），杀次数限制=${unlimited}`);
  }

  // T159 替身：准备阶段回复所有体力并摸等量
  {
    const g = game([{ name: '张飞', skills: ['j_tishen'], hp: 2, maxHp: 4 }]);
    g.deck = [C('sha', 'spade', 1), C('sha', 'spade', 2), C('sha', 'spade', 3)];
    g.handler = async (pl, req) => (req.type === 'chooseOption' && /替身/.test(req.reason || '')) ? 'yes' : null;
    await g.skillPhaseStart(g.players[0]);
    const p = g.players[0];
    t('T159', '替身回复并摸牌', p.hp === 4 && p.hand.length === 2 && p.once.tishen === true,
      `hp=${p.hp}（应4），摸牌=${p.hand.length}（应2），限定技已用=${!!p.once.tishen}`);
  }

  // T160 龙胆（界）：酒当桃、桃当酒
  {
    const g = game([{ name: '赵云', skills: ['j_longdan'], hp: 4 }, { name: '甲', hp: 4 }]);
    g.players[0].hand = [C('tao', 'heart', 3)];
    const a = g.buildPlayActions(g.players[0]).find((x) => x.kind === 'card' && x.as === 'jiu' && x.skill === 'j_longdan');
    // 酒当桃：可救其他濒死角色
    const g2 = game([{ name: '赵云', skills: ['j_longdan'], hp: 4 }, { name: '濒死', hp: 0 }]);
    const jiu = C('jiu', 'spade', 9);
    g2.players[0].hand = [jiu];
    g2.handler = async (pl, req) => (req.type === 'response' && req.need === 'tao') ? { cardId: req.options[0].cardId } : null;
    const saved = await g2.askForPeach(g2.players[0], g2.players[1]);
    t('T160', '龙胆（界）酒桃互转', !!a && !!saved && saved.usedName === 'jiu',
      `桃当酒入口=${!!a}，酒当桃救他人=${!!saved}（usedName=${saved && saved.usedName}）`);
  }

  // T161 勤学觉醒获得攻心；攻心可观看手牌并置顶红桃
  {
    const g = game([{ name: '吕蒙', skills: ['keji', 'j_qinxue'], hp: 2, maxHp: 3 }, { name: '甲', hp: 4 }]);
    const p = g.players[0];
    p.hand = [C('sha', 'spade', 1), C('sha', 'spade', 2), C('sha', 'spade', 3), C('sha', 'spade', 4)];
    g.handler = async (pl, req) => {
      if (req.type !== 'chooseOption') return null;
      if (/觉醒技/.test(req.reason || '')) return 'yes';
      if (/回复 1 点体力/.test(req.reason || '')) return 'heal';
      return null;
    };
    await g.skillPhaseStart(p);
    const awake = p.maxHp === 2 && p.skills.includes('gongxin') && !p.skills.includes('j_qinxue');
    const heart = C('tao', 'heart', 6), spade = C('sha', 'spade', 7);
    g.players[1].hand = [heart, spade];
    g.deck = [C('shan', 'club', 8)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseCards' && /攻心/.test(req.reason || '')) return [heart.id];
      if (req.type === 'chooseOption' && /攻心/.test(req.reason || '')) return 'top';
      return null;
    };
    await g.useSkillAction(p, { skill: 'gongxin', targets: [1] });
    const top = g.deck[g.deck.length - 1].id === heart.id && g.players[1].hand.length === 1 && p.used.gongxin === true;
    t('T161', '勤学觉醒+攻心置顶', awake && top,
      `觉醒=${awake}（maxHp=${p.maxHp}，技能=${p.skills.join(',')}），攻心置顶=${top}`);
  }

  // T162 奸雄（界）：摸一张并获得伤害牌
  {
    const g = game([{ name: '曹操', skills: ['j_jianxiong'], hp: 4 }, { name: '甲', hp: 4 }]);
    const sha = C('sha', 'spade', 7);
    g.discardPile = [sha];
    g.deck = [C('shan', 'diamond', 1)];
    g.handler = async (pl, req) => (req.type === 'chooseOption' && /奸雄/.test(req.reason || '')) ? 'yes' : null;
    await g.damage({ source: g.players[1], target: g.players[0], amount: 1, card: sha });
    const p = g.players[0];
    t('T162', '奸雄（界）摸牌并获得伤害牌', p.hand.length === 2 && p.hand.some((c) => c.id === sha.id),
      `手牌=${p.hand.length}（应2），含伤害牌=${p.hand.some((c) => c.id === sha.id)}`);
  }

  // T163 遗计（界）：摸两张，交给至多两名其他角色共计至多两张
  {
    const g = game([{ name: '郭嘉', skills: ['j_yiji'], hp: 4 }, { name: '甲', hp: 4 }]);
    g.deck = [C('sha', 'spade', 1), C('shan', 'diamond', 2)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /遗计/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCards') return (req.cards || []).map((c) => c.id).slice(0, 2);
      if (req.type === 'chooseTargets') return [1];
      return null;
    };
    await g.damage({ source: g.players[1], target: g.players[0], amount: 1 });
    const p = g.players[0], q = g.players[1];
    t('T163', '遗计（界）限两张牌', p.hand.length === 0 && q.hand.length === 2,
      `郭嘉手牌=${p.hand.length}（应0），甲手牌=${q.hand.length}（应2）`);
  }

  // T164 鬼才（界）：可用装备区的牌改判
  {
    const g = game([{ name: '司马懿', skills: ['j_guicai'], hp: 3 }, { name: '甲', hp: 4 }]);
    const bagua = C('bagua', 'club', 2);
    g.players[0].equips.armor = bagua;
    g.deck = [C('sha', 'spade', 5), C('tao', 'heart', 6)];
    g.handler = async (pl, req) => (req.type === 'response' && req.need === 'guicai') ? { cardId: bagua.id } : null;
    const res = await g.judge(g.players[1], '测试');
    t('T164', '鬼才（界）装备改判', res.card.id === bagua.id && g.players[0].equips.armor === null,
      `判定牌=${res.card && res.card.name}（应bagua），装备区=${g.players[0].equips.armor}`);
  }

  // T165 反馈（界）：每点伤害各获得一张
  {
    const g = game([{ name: '司马懿', skills: ['j_fankui'], hp: 4 }, { name: '甲', hp: 4 }]);
    g.players[1].hand = [C('sha', 'spade', 1), C('shan', 'diamond', 2)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /反馈/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      return null;
    };
    await g.damage({ source: g.players[1], target: g.players[0], amount: 2 });
    t('T165', '反馈（界）每点伤害各获一张', g.players[0].hand.length === 2 && g.players[1].hand.length === 0,
      `司马懿手牌=${g.players[0].hand.length}（应2），甲手牌=${g.players[1].hand.length}（应0）`);
  }

  // T166 刚烈（界）：红色→伤害来源 1 点；黑色→弃其一张牌
  {
    const red = game([{ name: '夏侯惇', skills: ['j_ganglie'], hp: 4 }, { name: '甲', hp: 4 }]);
    red.deck = [C('sha', 'spade', 1), C('tao', 'heart', 2)];
    red.handler = async (pl, req) => (req.type === 'chooseOption' && /刚烈/.test(req.reason || '')) ? 'yes' : null;
    await red.damage({ source: red.players[1], target: red.players[0], amount: 1 });
    const redOk = red.players[1].hp === 3;
    const black = game([{ name: '夏侯惇', skills: ['j_ganglie'], hp: 4 }, { name: '甲', hp: 4 }]);
    black.deck = [C('tao', 'heart', 1), C('sha', 'spade', 2)];
    black.players[1].hand = [C('sha', 'club', 3)];
    black.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /刚烈/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      return null;
    };
    await black.damage({ source: black.players[1], target: black.players[0], amount: 1 });
    const blackOk = black.players[1].hand.length === 0 && black.players[0].hp === 3; // 攻击造成1点 + 刚烈弃牌
    t('T166', '刚烈（界）红伤/黑弃', redOk && blackOk,
      `红色判定来源 hp=${red.players[1].hp}（应3），黑色判定来源手牌=${black.players[1].hand.length}（应0）`);
  }

  // T167 制衡（界）：弃光手牌额外摸 1
  {
    const g = game([{ name: '孙权', skills: ['j_zhiheng'], hp: 4 }]);
    const p = g.players[0];
    p.hand = [C('sha', 'spade', 1), C('sha', 'spade', 2)];
    g.deck = [C('shan', 'diamond', 3), C('shan', 'diamond', 4), C('tao', 'heart', 5)];
    g.handler = async () => null;
    await g.useSkillAction(p, { skill: 'j_zhiheng', cards: p.hand.map((c) => c.id), targets: [] });
    t('T167', '制衡（界）弃光额外摸1', p.hand.length === 3 && p.used.j_zhiheng === true,
      `弃2光手牌后手牌=${p.hand.length}（应3）`);
  }

  // T168 闭月（界）：无手牌摸2，否则摸1
  {
    const g = game([{ name: '貂蝉', skills: ['j_biyue'], hp: 3 }]);
    g.deck = [C('sha', 'spade', 1), C('shan', 'diamond', 2)];
    await g.phaseEnd(g.players[0]);
    const empty = g.players[0].hand.length === 2;
    const g2 = game([{ name: '貂蝉', skills: ['j_biyue'], hp: 3 }]);
    g2.players[0].hand = [C('tao', 'heart', 3)];
    g2.deck = [C('sha', 'spade', 4), C('shan', 'diamond', 5)];
    await g2.phaseEnd(g2.players[0]);
    const one = g2.players[0].hand.length === 2;
    t('T168', '闭月（界）0手牌摸2/否则摸1', empty && one,
      `空手牌后=${g.players[0].hand.length}（应2），有1手牌后=${g2.players[0].hand.length}（应2）`);
  }

  // T169 观星（界）：全部置底后结束阶段可再次发动
  {
    const g = game([{ name: '诸葛亮', skills: ['j_guanxing'], hp: 3 }, { name: '甲', hp: 4 }]);
    g.deck = [C('sha', 'spade', 1), C('sha', 'spade', 2), C('sha', 'spade', 3), C('sha', 'spade', 4)];
    let arranges = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'arrange') { arranges++; return { top: [], bottom: (req.cards || []).slice() }; }
      if (req.type === 'chooseOption' && /观星/.test(req.reason || '')) return 'yes';
      return null;
    };
    await g.skillPhaseStart(g.players[0]);
    const first = arranges === 1 && g.players[0].flags.guanxingAllBottom === true;
    await g.skillEndPhase(g.players[0]);
    t('T169', '观星（界）全置底结束再发动', first && arranges === 2,
      `准备阶段发动=${first}，总发动次数=${arranges}（应2）`);
  }

  // T170 苦肉（界）+诈降：弃牌失血摸3，红杀强化
  {
    const g = game([{ name: '黄盖', skills: ['j_kurou', 'j_zhaxiang'], hp: 4 }]);
    const p = g.players[0];
    const cost = C('sha', 'spade', 1);
    p.hand = [cost];
    g.deck = [C('shan', 'diamond', 2), C('shan', 'diamond', 3), C('sha', 'spade', 4)];
    g.phase = 'play'; g.currentSeat = 0;
    await g.useSkillAction(p, { skill: 'j_kurou', cards: [cost.id], targets: [] });
    const base = p.hp === 3 && p.hand.length === 3 && p.flags.zhaxiang === true && p.used.j_kurou === true;
    p.slashCount = 1;
    const extra = g.canUseSlash(p) === true;
    t('T170', '苦肉/诈降（界）', base && extra,
      `失血后 hp=${p.hp}（应3），摸牌=${p.hand.length}（应3），诈降标记=${!!p.flags.zhaxiang}，杀次数+1=${extra}`);
  }

  // T171 突袭（界）：少摸任意张，获得等量角色各一张
  {
    const g = game([{ name: '张辽', skills: ['j_tuxi'], hp: 4 }, { name: '甲', hp: 4 }, { name: '乙', hp: 4 }, { name: '丙', hp: 4 }]);
    const p = g.players[0];
    g.players[1].hand = [C('sha', 'spade', 1)];
    g.players[2].hand = [C('shan', 'diamond', 2)];
    g.deck = [C('tao', 'heart', 3), C('tao', 'heart', 4), C('tao', 'heart', 5)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /是否发动【突袭】/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseOption' && /少摸的张数/.test(req.reason || '')) return '2';
      if (req.type === 'chooseTargets') return [1, 2];
      return null;
    };
    await g.phaseDraw(p);
    t('T171', '突袭（界）少摸等量获得', p.hand.length === 2 && g.players[1].hand.length === 0 && g.players[2].hand.length === 0,
      `张辽手牌=${p.hand.length}（应2），甲/乙手牌=${g.players[1].hand.length}/${g.players[2].hand.length}（应0/0）`);
  }

  // T172 反间（界）：同花色弃置 或 失去1体力
  {
    const g = game([{ name: '周瑜', skills: ['j_fanjian'], hp: 3 }, { name: '甲', hp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    const heart = C('tao', 'heart', 3), h2 = C('shan', 'heart', 4), spade = C('sha', 'spade', 5);
    p.hand = [heart]; tgt.hand = [h2, spade];
    g.handler = async (pl, req) => (req.type === 'chooseOption' && /反间/.test(req.reason || '')) ? 'discard' : null;
    await g.useSkillAction(p, { skill: 'j_fanjian', cards: [heart.id], targets: [1] });
    const discardOk = tgt.hand.length === 1 && tgt.hand[0].id === spade.id && p.hand.length === 0;
    const g2 = game([{ name: '周瑜', skills: ['j_fanjian'], hp: 3 }, { name: '甲', hp: 4 }]);
    const p2 = g2.players[0], t2 = g2.players[1];
    const c2 = C('tao', 'heart', 6);
    p2.hand = [c2]; t2.hand = [C('sha', 'spade', 7)];
    g2.handler = async (pl, req) => (req.type === 'chooseOption' && /反间/.test(req.reason || '')) ? 'losehp' : null;
    await g2.useSkillAction(p2, { skill: 'j_fanjian', cards: [c2.id], targets: [1] });
    const loseOk = t2.hp === 3;
    t('T172', '反间（界）弃同花色/失血', discardOk && loseOk,
      `弃花色后甲手牌=${tgt.hand.length}（应1剩黑桃），失血分支 hp=${t2.hp}（应3）`);
  }

  // T173 势斩：令其他角色视为对你使用决斗，每阶段两次
  {
    const g = game([{ name: '华雄', skills: ['shizhan'], hp: 6 }, { name: '甲', hp: 4 }]);
    const p = g.players[0];
    g.phase = 'play'; g.currentSeat = 0;
    g.handler = async () => null;
    await g.useSkillAction(p, { skill: 'shizhan', targets: [1] });
    const hpFirst = p.hp;
    const once = p.hp === 5 && p.used.shizhan === 1;
    const collect = () => { const arr = []; g.buildSkillActions(p, (a) => arr.push(a)); return arr; };
    const acts1 = collect();
    const available1 = acts1.some((a) => a.skill === 'shizhan');
    await g.useSkillAction(p, { skill: 'shizhan', targets: [1] });
    const twice = p.hp === 4 && p.used.shizhan === 2;
    const acts2 = collect();
    const exhausted = !acts2.some((a) => a.skill === 'shizhan');
    t('T173', '势斩两次决斗', once && available1 && twice && exhausted,
      `第一次后 hp=${hpFirst}（应5），两次后 hp=${p.hp}（应4），用尽后无入口=${exhausted}`);
  }

  // T174 连营（界）：失去所有手牌后令至多X名角色各摸一张
  {
    const g = game([{ name: '陆逊', skills: ['qianxun', 'j_lianying'], hp: 3 }, { name: '甲', hp: 4 }]);
    const p = g.players[0];
    p.hand = [];
    const lost = [C('sha', 'spade', 1), C('shan', 'diamond', 2)];
    g.deck = [C('sha', 'club', 3), C('shan', 'heart', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /连营/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseTargets') return [0, 1];
      return null;
    };
    await g.afterLoseCardsHook(p, lost);
    const ok = p.hand.length === 1 && g.players[1].hand.length === 1;
    t('T174', '连营（界）失去手牌令X人摸牌', ok,
      `陆逊手牌=${p.hand.length}（应1），甲手牌=${g.players[1].hand.length}（应1）`);
  }

  // ================= P2 变体技能 =================
  // T175 数据与隔离：P2 新技能全部独立且只挂 extras
  {
    const ids = ['j_yijue','j_tieji','j_yingzi','j_guose','j_luoyi','j_luoshen','j_jieyin','j_jizhi','j_qicai','j_jiuyuan','j_liyu','j_chuli'];
    const defs = ids.every((id) => D.SKILLS[id] && D.SKILLS[id].desc);
    const used = new Set(D.EXTRA_GENERALS.reduce((a, g) => a.concat(g.skills), []));
    const usedOk = ids.every((id) => used.has(id));
    const baseLeak = D.GENERALS.filter((g) => g.pack !== 'extras').some((g) => g.skills.some((sid) => ids.includes(sid)));
    const map = [[300, 'j_wusheng,j_yijue'], [303, 'mashu,j_tieji'], [308, 'j_yingzi,j_fanjian'], [309, 'j_guose,liuli'], [315, 'j_luoyi'], [318, 'jijiu,j_chuli'], [319, 'wushuang,j_liyu'], [441, 'j_jizhi,j_qicai'], [442, 'j_zhiheng,j_jiuyuan'], [443, 'j_jieyin,xiaoji'], [444, 'j_luoshen,qingguo']];
    const mapOk = map.every(([id, sk]) => { const gg = D.GENERALS.find((x) => x.id === id); return gg && gg.skills.join(',') === sk; });
    t('T175', 'P2 技能数据与隔离', defs && usedOk && !baseLeak && mapOk,
      `定义/文案=${defs}，全部被引用=${usedOk}，基础将泄漏=${baseLeak}（应false），11 将技能指向=${mapOk}`);
  }

  // T176 英姿（周瑜 Po）：多摸一张；手牌上限=体力上限
  {
    const g = game([{ name: '周瑜', skills: ['j_yingzi'], hp: 2, maxHp: 4 }]);
    const p = g.players[0];
    g.deck = [C('sha', 'spade', 1), C('sha', 'spade', 2), C('sha', 'spade', 3), C('sha', 'spade', 4), C('sha', 'spade', 5)];
    g.handler = async () => null;
    await g.phaseDraw(p);
    const drew = p.hand.length === 3;
    p.hand = p.hand.concat([C('tao', 'heart', 6)]);
    await g.phaseDiscard(p);
    const limit = p.hand.length === 4; // 体力2但上限4，不应弃到2
    t('T176', '英姿（界）多摸+手牌上限', drew && limit,
      `摸牌阶段手牌=${drew ? 3 : p.hand.length}（应3），弃牌阶段后手牌=${p.hand.length}（应4）`);
  }

  // T177 洛神（甄姬 Po）：黑色获得并记录不计入手牌上限
  {
    const g = game([{ name: '甄姬', skills: ['j_luoshen'], hp: 1, maxHp: 3 }]);
    const p = g.players[0];
    g.deck = [C('tao', 'heart', 2), C('sha', 'spade', 5)]; // 顶部为黑桃
    let cont = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /继续发动【洛神】/.test(req.reason || '')) { cont++; return 'no'; }
      return null;
    };
    await g.phaseStart(p);
    const got = p.hand.length === 1 && Array.isArray(p.flags.luoshenIds) && p.flags.luoshenIds.length === 1;
    const gainedId = p.flags.luoshenIds[0];
    p.hand = p.hand.concat([C('shan', 'diamond', 7), C('tao', 'heart', 8)]);
    g.handler = async (pl, req) => req.type === 'chooseCards' ? [req.cards[0].id] : null;
    await g.phaseDiscard(p);
    const limitOk = p.hand.length === 2; // hp1 + 洛神1 = 2
    t('T177', '洛神（界）获得牌不计上限', got && limitOk && cont === 1,
      `获得牌/记录=${got}，弃牌后手牌=${p.hand.length}（应2，含洛神牌）`);
  }

  // T178 集智（黄月英 Po）：非转化锦囊摸一张，基本牌可弃置换手牌上限+1
  {
    const g = game([{ name: '黄月英', skills: ['j_jizhi', 'j_qicai'], hp: 3 }]);
    const p = g.players[0];
    const wu = C('wuzhong', 'heart', 3);
    p.hand = [wu];
    g.deck = [C('shan', 'diamond', 1), C('tao', 'heart', 2)]; // 顶为基本牌
    let asks = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /集智/.test(req.reason || '')) { asks++; return 'yes'; }
      return null;
    };
    await g.useVirtualCard(p, [wu], 'wuzhong', null, [p]);
    t('T178', '集智（界）摸牌与上限+1', asks === 1 && p.flags.jizhiLimit === 1,
      `集智询问=${asks}（应1），手牌上限加成=${p.flags.jizhiLimit}（应1）`);
  }

  // T179 奇才：锦囊无距离；防止其他角色弃置防具
  {
    const g = game([{ name: '黄月英', skills: ['j_qicai'], hp: 3 }, { name: '甲', hp: 4 }, { name: '乙', hp: 4 }, { name: '丙', hp: 4 }]);
    const p = g.players[0];
    g.players[2].hand = [C('sha', 'spade', 1)];
    const noDist = g.legalTargetsFor(p, 'shunshou', null).includes(2);
    const bagua = C('bagua', 'club', 2);
    g.players[1].equips.armor = bagua;
    g.players[1].skills = ['j_qicai'];
    g.handler = async (pl, req) => req.type === 'chooseCardFrom' ? { zone: 'equip', slot: 'armor' } : null;
    const got = await g.pickCardFrom(g.players[1], g.players[0], { zones: ['equip'], reason: '过河拆桥：选择弃置一张牌' });
    const prevented = got === null && g.players[1].equips.armor && g.players[1].equips.armor.id === bagua.id;
    t('T179', '奇才无距离/防具保护', noDist && prevented,
      `顺手可选隔位=${noDist}，弃防具被防止=${prevented}`);
  }

  // T180 救援（孙权 Po）：吴势力角色回合内回复可改为主公回复并摸牌
  {
    const g = game([{ name: '孙权', role: 'lord', kingdom: '吴', skills: ['j_jiuyuan'], hp: 3, maxHp: 4 }, { name: '周瑜', kingdom: '吴', skills: [], hp: 3, maxHp: 3 }]);
    const lord = g.players[0], ally = g.players[1];
    g.currentSeat = 1;
    g.deck = [C('sha', 'spade', 1)];
    g.handler = async (pl, req) => (req.type === 'chooseOption' && /救援/.test(req.reason || '')) ? 'yes' : null;
    await g.recover(ally, 1, ally, '测试');
    const ok = lord.hp === 4 && ally.hp === 3 && ally.hand.length === 1;
    t('T180', '救援改为主公回复并摸牌', ok,
      `主公 hp=${lord.hp}（应4），吴将 hp=${ally.hp}（应3），吴将手牌=${ally.hand.length}（应1）`);
  }

  // T181 裸衣：亮3张，跳过摸牌获得基本/武器/决斗，杀伤害+1
  {
    const g = game([{ name: '许褚', skills: ['j_luoyi'], hp: 4 }, { name: '甲', hp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    g.deck = [C('tao', 'heart', 1), C('zhugeliannu', 'club', 2), C('guohe', 'spade', 3), C('sha', 'spade', 4)];
    g.handler = async (pl, req) => {
      if (req.type !== 'chooseOption' || !/裸衣/.test(req.reason || '')) return null;
      return 'yes';
    };
    await g.phaseDraw(p);
    const gained = p.hand.length === 2 && p.flags.luoyiBonus === true;
    await g.resolveSlash(p, { id: 401, name: 'sha', type: 'basic', suit: 'spade', rank: 9, color: 'black', cards: [] }, [tgt]);
    const bonus = tgt.hp === 2;
    t('T181', '裸衣亮牌跳过摸牌+伤害', gained && bonus,
      `获得${p.hand.length}张（应2），裸衣标记=${!!p.flags.luoyiBonus}，杀伤害=${4 - tgt.hp}（应2）`);
  }

  // T182 国色（大乔 Po）：方块当乐不思蜀并摸一张
  {
    const g = game([{ name: '大乔', skills: ['j_guose', 'liuli'], hp: 3 }, { name: '甲', hp: 4 }]);
    const p = g.players[0];
    const diamond = C('shan', 'diamond', 5), other = C('sha', 'spade', 6);
    p.hand = [diamond, other];
    g.deck = [C('tao', 'heart', 7)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /国色/.test(req.reason || '')) return 'lebu';
      if (req.type === 'chooseTargets') return [1];
      return null;
    };
    await g.useSkillAction(p, { skill: 'j_guose', cards: [diamond.id], targets: [] });
    const ok = g.players[1].judges.some((c) => c.name === 'lebu') && p.used.j_guose === true && p.hand.length === 2;
    t('T182', '国色方块当乐并摸牌', ok,
      `目标判定区乐=${g.players[1].judges.some((c) => c.name === 'lebu')}，已发动=${!!p.used.j_guose}，手牌=${p.hand.length}（应2）`);
  }

  // T183 结姻（孙尚香 Po）：弃手牌后体力大者摸、小者回
  {
    const g = game([{ name: '孙尚香', gender: 'female', skills: ['j_jieyin', 'xiaoji'], hp: 3, maxHp: 4 }, { name: '甲', gender: 'male', hp: 4, maxHp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    p.hand = [C('sha', 'spade', 1)];
    g.handler = async (pl, req) => req.type === 'chooseCards' ? [req.cards[0].id] : null;
    await g.useSkillAction(p, { skill: 'j_jieyin', cards: [], targets: [1] });
    const ok = p.hp === 4 && tgt.hand.length === 1 && p.used.j_jieyin === true;
    t('T183', '结姻体力大摸/小回', ok,
      `孙尚香 hp=${p.hp}（应4），甲手牌=${tgt.hand.length}（应1）`);
  }

  // T184 铁骑（马超 Po）：判定同花色弃牌可闪；未弃则不能闪且非锁定技失效
  {
    const g = game([{ name: '马超', skills: ['mashu', 'j_tieji'], hp: 4 }, { name: '甲', hp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    const spade = C('sha', 'spade', 7), shan = C('shan', 'diamond', 8);
    tgt.hand = [spade, shan];
    g.deck = [C('tao', 'heart', 1), C('sha', 'spade', 5)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /铁骑/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCards' && /铁骑/.test(req.reason || '')) return [spade.id];
      if (req.type === 'response' && req.need === 'shan') return { cardId: shan.id };
      return null;
    };
    await g.resolveSlash(p, { id: 402, name: 'sha', type: 'basic', suit: 'spade', rank: 6, color: 'black', cards: [] }, [tgt]);
    const discardDodge = tgt.hp === 4 && !tgt.hand.some((c) => c.id === spade.id);
    // 无同花色牌：不能闪 + 刚烈被失效
    const g2 = game([{ name: '马超', skills: ['mashu', 'j_tieji'], hp: 4 }, { name: '甲', skills: ['ganglie'], hp: 4 }]);
    const p2 = g2.players[0], t2 = g2.players[1];
    t2.hand = [C('shan', 'diamond', 9)];
    g2.deck = [C('sha', 'spade', 1), C('tao', 'heart', 2)]; // 判红桃
    g2.handler = async (pl, req) => (req.type === 'chooseOption' && /铁骑/.test(req.reason || '')) ? 'yes' : null;
    await g2.resolveSlash(p2, { id: 403, name: 'sha', type: 'basic', suit: 'spade', rank: 6, color: 'black', cards: [] }, [t2]);
    const noShan = t2.hp === 3 && t2.flags.noSkills === true && p2.hp === 4;
    t('T184', '铁骑弃同花色/封锁闪与技能', discardDodge && noShan,
      `弃牌后可闪=${discardDodge}，无同花色不能闪=${t2.hp === 3}，非锁定技失效=${!!t2.flags.noSkills}，刚烈未触发=${p2.hp === 4}`);
  }

  // T185 义绝（关羽 Po）：黑牌封锁手牌/技能；红牌获得并可令其回血
  {
    const g = game([{ name: '关羽', skills: ['j_wusheng', 'j_yijue'], hp: 4 }, { name: '甲', hp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    p.hand = [C('sha', 'spade', 1)];
    tgt.hand = [C('tao', 'spade', 2)];
    g.handler = async (pl, req) => {
      if (req.type !== 'chooseCards') return null;
      if (pl === p) return [p.hand[0].id];
      return [tgt.hand[0].id];
    };
    await g.useSkillAction(p, { skill: 'j_yijue', cards: [p.hand[0].id], targets: [1] });
    const black = tgt.flags.noSkills === true && tgt.flags.noHand === true && p.flags.yijueTargets && p.flags.yijueTargets[1] === true && g.shanOptions(tgt).length === 0;
    const g2 = game([{ name: '关羽', skills: ['j_wusheng', 'j_yijue'], hp: 4 }, { name: '甲', hp: 3, maxHp: 4 }]);
    const p2 = g2.players[0], t2 = g2.players[1];
    p2.hand = [C('sha', 'spade', 3)];
    t2.hand = [C('tao', 'heart', 4)];
    g2.handler = async (pl, req) => {
      if (req.type === 'chooseCards') { if (pl === p2) return [p2.hand[0].id]; return [t2.hand[0].id]; }
      if (req.type === 'chooseOption' && /义绝/.test(req.reason || '')) return 'yes';
      return null;
    };
    await g2.useSkillAction(p2, { skill: 'j_yijue', cards: [p2.hand[0].id], targets: [1] });
    const red = p2.hand.some((c) => c.name === 'tao') && t2.hp === 4 && t2.hand.length === 0;
    t('T185', '义绝黑封锁/红获得', black && red,
      `黑牌：封锁技能=${!!tgt.flags.noSkills}，禁手牌=${!!tgt.flags.noHand}，无闪可选=${g.shanOptions(tgt).length === 0}；红牌：获得=${p2.hand.some((c) => c.name === 'tao')}，目标回血=${t2.hp === 4}`);
  }

  // T186 除疠（华佗 Po）：选不同势力角色，各弃一张，黑桃摸牌
  {
    const g = game([{ name: '华佗', skills: ['jijiu', 'j_chuli'], hp: 3 }, { name: '甲', kingdom: '魏', hp: 4 }, { name: '乙', kingdom: '蜀', hp: 4 }]);
    const p = g.players[0];
    p.hand = [C('sha', 'spade', 1), C('sha', 'heart', 2)];
    g.players[1].hand = [C('tao', 'club', 3)];
    g.players[2].hand = [C('shan', 'diamond', 4)];
    g.deck = [C('tao', 'heart', 5)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseCards') return [req.cards[0].id];
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      return null;
    };
    await g.useSkillAction(p, { skill: 'j_chuli', cards: [], targets: [1, 2] });
    const ok = g.players[1].hand.length === 0 && g.players[2].hand.length === 0 && p.hand.length === 1 && p.used.j_chuli === true;
    t('T186', '除疠多势力弃牌', ok,
      `甲/乙手牌=${g.players[1].hand.length}/${g.players[2].hand.length}（应0/0），华佗手牌=${p.hand.length}（应1，黑桃补牌）`);
  }

  // T187 利驭（吕布 Po）：获得装备后由目标指定角色决斗
  {
    const g = game([{ name: '吕布', skills: ['wushuang', 'j_liyu'], hp: 4 }, { name: '甲', hp: 4 }, { name: '乙', hp: 4 }]);
    const p = g.players[0], tgt = g.players[1], victim = g.players[2];
    const weapon = C('qinglong', 'spade', 5);
    tgt.equips.weapon = weapon;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /利驭/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'weapon' };
      if (req.type === 'chooseTargets') return [2];
      return null;
    };
    const sha = C('sha', 'spade', 7);
    await g.damage({ source: p, target: tgt, amount: 1, card: sha });
    const ok = p.hand.some((c) => c.id === weapon.id) && victim.hp === 3;
    t('T187', '利驭获得装备并决斗', ok,
      `吕布获得武器=${p.hand.some((c) => c.id === weapon.id)}，被指定者 hp=${victim.hp}（应3）`);
  }

  // ================= P3 变体技能 =================
  // T188 数据与隔离
  {
    const ids = ['j_yajiao','j_fenwei','j_qianxun','j_hujia','j_qingjian','j_chongzhen','j_liegong'];
    const defs = ids.every((id) => D.SKILLS[id] && D.SKILLS[id].desc);
    const used = new Set(D.EXTRA_GENERALS.reduce((a, g) => a.concat(g.skills), []));
    const usedOk = ids.every((id) => used.has(id));
    const baseLeak = D.GENERALS.filter((g) => g.pack !== 'extras').some((g) => g.skills.some((sid) => ids.includes(sid)));
    const map = [[61, 'j_liegong'], [108, 'longdan,j_chongzhen'], [302, 'j_longdan,j_yajiao'], [305, 'qixi,j_fenwei'], [310, 'j_qianxun,j_lianying'], [311, 'j_jianxiong,j_hujia'], [313, 'j_ganglie,j_qingjian']];
    const mapOk = map.every(([id, sk]) => { const gg = D.GENERALS.find((x) => x.id === id); return gg && gg.skills.join(',') === sk; });
    t('T188', 'P3 技能数据与隔离', defs && usedOk && !baseLeak && mapOk,
      `定义/文案=${defs}，全部被引用=${usedOk}，基础将泄漏=${baseLeak}（应false），7 将指向=${mapOk}`);
  }

  // T189 烈弓（黄忠 Po）：仅出牌阶段触发；非出牌阶段不询问
  {
    const mk = (phase) => {
      const g = game([{ name: '黄忠', skills: ['j_liegong'], hp: 4 }, { name: '甲', hp: 4 }]);
      g.players[1].hand = [C('sha', 'spade', 1), C('sha', 'spade', 2), C('sha', 'spade', 3), C('sha', 'spade', 4)];
      g.phase = phase;
      let n = 0;
      g.handler = async (pl, req) => { if (req.type === 'chooseOption' && /烈弓/.test(req.reason || '')) { n++; return 'yes'; } return null; };
      return { g, n: () => n };
    };
    const a = mk('play');
    await a.g.resolveSlash(a.g.players[0], { id: 501, name: 'sha', type: 'basic', suit: 'spade', rank: 5, color: 'black', cards: [] }, [a.g.players[1]]);
    const playOk = a.n() === 1 && a.g.players[1].hp === 3;
    const b = mk('judge');
    await b.g.resolveSlash(b.g.players[0], { id: 502, name: 'sha', type: 'basic', suit: 'spade', rank: 5, color: 'black', cards: [] }, [b.g.players[1]]);
    const timingOk = b.n() === 0 && b.g.players[1].hp === 3;
    t('T189', '烈弓（界）仅出牌阶段', playOk && timingOk,
      `出牌阶段询问=${a.n()}/命中=${a.g.players[1].hp === 3}，判定阶段询问=${b.n()}（应0）`);
  }

  // T190 涯角：回合外使用牌，类型相同给牌；不同弃攻击范围内角色一张
  {
    const g = game([{ name: '甲', hp: 4 }, { name: '赵云', skills: ['j_yajiao'], hp: 4 }]);
    const p = g.players[1];
    g.currentSeat = 0;
    g.deck = [C('tao', 'heart', 2)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /涯角/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseTargets') return [0];
      return null;
    };
    await g.yajiaoTrigger(p, C('sha', 'spade', 1));
    const same = g.players[0].hand.length === 1;
    const g2 = game([{ name: '甲', hp: 4 }, { name: '赵云', skills: ['j_yajiao'], hp: 4 }]);
    const p2 = g2.players[1];
    g2.currentSeat = 0;
    g2.players[0].hand = [C('sha', 'club', 4)];
    g2.deck = [C('guohe', 'spade', 3)];
    g2.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /涯角/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseTargets') return [0];
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      return null;
    };
    await g2.yajiaoTrigger(p2, C('sha', 'spade', 5));
    const diff = g2.players[0].hand.length === 0;
    t('T190', '涯角同类型给牌/不同类型弃牌', same && diff,
      `类型相同给牌=${same}，类型不同弃牌=${diff}`);
  }

  // T191 奋威：多目标锦囊指定目标后令任意目标无效，限定一次
  {
    const g = game([{ name: '甘宁', skills: ['qixi'], hp: 4 }, { name: '甲', hp: 4 }, { name: '乙', skills: ['j_fenwei'], hp: 4 }]);
    const src = g.players[0];
    const nm = C('nanman', 'spade', 7), nm2 = C('nanman', 'club', 8);
    src.hand = [nm, nm2];
    let asks = 0;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /奋威/.test(req.reason || '')) { asks++; return 'yes'; }
      if (req.type === 'chooseTargets') return [1];
      return null;
    };
    await g.useVirtualCard(src, [nm], 'nanman', null, []);
    const hp1First = g.players[1].hp, hp2First = g.players[2].hp;
    const first = asks === 1 && hp1First === 4 && hp2First === 3 && g.players[2].once.fenwei === true;
    await g.useVirtualCard(src, [nm2], 'nanman', null, []);
    const once = asks === 1 && g.players[1].hp === 3;
    t('T191', '奋威令目标无效/限定一次', first && once,
      `首次：甲 hp=${hp1First}（应4）、乙 hp=${hp2First}（应3）；第二次奋威询问=${asks}（应1），甲/乙 hp=${g.players[1].hp}/${g.players[2].hp}`);
  }

  // T192 谦逊：普通锦囊唯一目标时移出所有手牌，回合结束移回
  {
    const g = game([{ name: '甲', hp: 4 }, { name: '陆逊', skills: ['j_qianxun', 'j_lianying'], hp: 3 }]);
    const src = g.players[0], tgt = g.players[1];
    tgt.hand = [C('sha', 'spade', 1), C('tao', 'heart', 2)];
    g.currentSeat = 0;
    g.handler = async (pl, req) => (req.type === 'chooseOption' && /谦逊/.test(req.reason || '')) ? 'yes' : null;
    const vc = { id: 601, name: 'guohe', type: 'trick', suit: 'spade', rank: 3, color: 'black', cards: [] };
    await g.resolveVirtualCard(src, vc, [tgt], {});
    const exiled = tgt.hand.length === 0 && Array.isArray(tgt.marks.exile) && tgt.marks.exile.length === 2;
    await g.phaseEnd(src);
    const returned = tgt.hand.length === 2 && tgt.marks.exile.length === 0;
    t('T192', '谦逊移出手牌并移回', exiled && returned,
      `移出=${exiled}（手牌${tgt.hand.length}），回合结束移回=${returned}（手牌${tgt.hand.length}）`);
  }

  // T193 护驾（曹操 Po）：魏将替主公出闪后主公摸牌，每回合一次
  {
    const g = game([{ name: '曹操', role: 'lord', kingdom: '魏', skills: ['j_jianxiong', 'j_hujia'], hp: 4 }, { name: '魏将', kingdom: '魏', skills: [], hp: 4 }, { name: '刺客', kingdom: '群', skills: [], hp: 4 }]);
    const lord = g.players[0], ally = g.players[1], atk = g.players[2];
    const shan = C('shan', 'diamond', 1), shan2 = C('shan', 'heart', 2);
    ally.hand = [shan, shan2];
    g.currentSeat = 2;
    g.deck = [C('sha', 'spade', 3), C('sha', 'spade', 4)];
    let rewardAsks = 0;
    g.handler = async (pl, req) => {
      if (pl === ally && req.type === 'response' && req.need === 'shan') return { cardId: req.options[0].cardId };
      if (req.type === 'chooseOption' && /护驾/.test(req.reason || '')) { rewardAsks++; return 'yes'; }
      return null;
    };
    const vc = { id: 602, name: 'sha', type: 'basic', suit: 'spade', rank: 5, color: 'black', cards: [] };
    const ok = await g.askForShan(lord, { source: atk, card: vc, reason: '测试' });
    const first = ok && lord.hand.length === 1 && ally.hand.length === 1 && rewardAsks === 1;
    await g.askForShan(lord, { source: atk, card: vc, reason: '测试' });
    const once = rewardAsks === 1 && lord.hand.length === 1;
    t('T193', '护驾回合外闪摸牌/每回合一次', first && once,
      `首次主公摸牌=${lord.hand.length}（应1），询问=${rewardAsks}（应1）；第二次同回合不再摸=${once}`);
  }

  // T194 清俭：摸牌阶段外获得牌→交牌，当前回合角色上限+X；同回合一次
  {
    const g = game([{ name: '甲', hp: 4 }, { name: '夏侯惇', skills: ['j_ganglie', 'j_qingjian'], hp: 4 }]);
    const p = g.players[1], cur = g.players[0];
    const basic = C('sha', 'spade', 1), equip = C('bagua', 'club', 2);
    p.hand = [basic, equip];
    g.phase = 'play'; g.currentSeat = 0; g.turnCount = 1;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /清俭/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCards') return req.cards.map((c) => c.id);
      if (req.type === 'chooseTargets') return [0];
      return null;
    };
    await g.afterCardGainHook(p, [basic, equip]);
    const first = p.hand.length === 0 && cur.hand.length === 2 && cur.flags.qingjianLimit === 2;
    let asks = 0;
    g.handler = async (pl, req) => { if (/清俭/.test(req.reason || '')) asks++; return null; };
    const extra = C('tao', 'heart', 3);
    p.hand = [extra];
    await g.afterCardGainHook(p, [extra]);
    const once = asks === 0 && p.hand.length === 1;
    t('T194', '清俭交牌/上限+X/每回合一次', first && once,
      `交牌后甲手牌=${cur.hand.length}（应2），当前回合上限+X=${cur.flags.qingjianLimit}（应2），二次询问=${asks}（应0）`);
  }

  // T195 清俭上限参与弃牌阶段
  {
    const g = game([{ name: '夏侯惇', skills: ['j_ganglie', 'j_qingjian'], hp: 1, maxHp: 3 }]);
    const p = g.players[0];
    p.hand = [C('sha', 'spade', 1), C('sha', 'spade', 2), C('sha', 'spade', 3), C('sha', 'spade', 4), C('sha', 'spade', 5)];
    p.flags.qingjianLimit = 2;
    g.handler = async (pl, req) => req.type === 'chooseCards' ? req.cards.slice(0, req.min).map((c) => c.id) : null;
    await g.phaseDiscard(p);
    t('T195', '清俭手牌上限参与弃牌', p.hand.length === 3,
      `hp1+清俭2=上限3，弃牌后手牌=${p.hand.length}（应3）`);
  }

  // T196 冲阵：发动龙胆时获得对方一张手牌
  {
    const g = game([{ name: '刺客', hp: 4 }, { name: '赵云', skills: ['longdan', 'j_chongzhen'], hp: 4 }]);
    const atk = g.players[0], p = g.players[1];
    atk.hand = [C('tao', 'heart', 3)];
    const sha = C('sha', 'spade', 4);
    p.hand = [sha];
    g.handler = async (pl, req) => {
      if (pl === p && req.type === 'response' && req.need === 'shan') return { cardId: sha.id, as: 'shan', skill: 'longdan' };
      if (req.type === 'chooseOption' && /冲阵/.test(req.reason || '')) return 'yes';
      return null;
    };
    const vc = { id: 603, name: 'sha', type: 'basic', suit: 'spade', rank: 6, color: 'black', cards: [] };
    const ok = await g.askForShan(p, { source: atk, card: vc, reason: '测试' });
    const gained = ok && p.hand.length === 1 && p.hand[0].name === 'tao' && atk.hand.length === 0;
    t('T196', '冲阵发动龙胆获得对方手牌', gained,
      `赵云手牌=${p.hand.length}（应1张桃），刺客手牌=${atk.hand.length}（应0）`);
  }

  // T197 火攻：目标自己选择展示牌
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0], q = g.players[1];
    const heart = C('tao', 'heart', 2), clubShown = C('sha', 'club', 3), clubPay = C('sha', 'club', 4);
    q.hand = [heart, clubShown]; p.hand = [clubPay];
    let targetAsked = false;
    g.handler = async (pl, req) => {
      if (req.type === 'chooseCards' && pl === q && /火攻/.test(req.reason || '')) {
        targetAsked = true;
        return [clubShown.id];
      }
      if (req.type === 'chooseCards' && pl === p && /火攻/.test(req.reason || '')) return [clubPay.id];
      return null;
    };
    await g.resolveFireAttack(p, { id: -50, name: 'huogong', type: 'trick', suit: 'heart', color: 'red', cards: [] }, q);
    t('T197', '火攻目标自选展示牌', targetAsked && q.hp === 3, '目标展示询问=' + targetAsked + '，乙hp=' + q.hp + '（应3）');
  }

  // T198 判定结构化事件（延时锦囊/八卦共用）
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    g.deck = [C('sha', 'spade', 7)];
    const before = g.recent.length;
    await g.judge(p, 'lebu');
    const ev = g.recent[g.recent.length - 1];
    t('T198', '判定发出结构化事件', g.recent.length > before && ev && ev.kind === 'judge' && ev.reason === '乐不思蜀' && ev.card && ev.card.name === 'sha' && ev.card.suit === 'spade',
      'event=' + JSON.stringify(ev));
  }

  // ================= New1V1 独立将池 =================
  // T199 数据与隔离：7 人、晋、pack=new1v1、技能已定义、不进入 GENERALS/普通池
  {
    const ids = [7000, 7001, 7002, 7004, 7005, 7006, 7007];
    const names = ['张虎乐綝', '夏侯徽', '司马师', '司马昭', '王元姬', '杜预', '张春华'];
    const ng = D.NEW_DUEL_GENERALS || [];
    const dataOk = ng.length === 7 && ids.every((id) => ng.some((g) => g.id === id && g.pack === 'new1v1' && g.kingdom === '晋')) && names.every((n) => ng.some((g) => g.name === n));
    const notInPool = ng.every((g) => !D.GENERALS.some((x) => x.id === g.id));
    const skillOk = ng.every((g) => g.skills.every((sid) => D.SKILLS[sid] && D.SKILLS[sid].desc));
    const hp = ng.find((g) => g.id === 7000).hp === 4 && ng.find((g) => g.id === 7001).gender === 'female' && ng.find((g) => g.id === 7006).hp === 4;
    const color = Object.prototype.hasOwnProperty.call(D.KINGDOM_COLOR, '晋');
    t('T199', 'New1V1 数据与隔离', dataOk && notInPool && skillOk && hp && color,
      `7人/晋/pack=${dataOk}，不在 GENERALS=${notInPool}，技能可解析=${skillOk}，体力性别抽查=${hp}，晋势力色=${color}`);
  }

  // T200 池门控：普通 8p/1v1(all/classic)/3v3 不含 New1V1；仅 duelPool='new1v1' 使用
  {
    const newIds = new Set(D.NEW_DUEL_GENERALS.map((g) => g.id));
    let leak = 0;
    for (const cfg of [{ mode: '8p' }, { mode: '3v3' }, { mode: '1v1', duelPool: 'all' }, { mode: '1v1', duelPool: 'classic' }]) {
      const g = new SGS.Game(Object.assign({ seed: 31, humanSeat: -1, onUpdate() {} }, cfg));
      g.setup();
      if (g.players.some((p) => (p.candidates || []).some((c) => newIds.has(c.id)))) leak++;
    }
    const gn = new SGS.Game({ mode: '1v1', duelPool: 'new1v1', seed: 32, humanSeat: -1, onUpdate() {} });
    gn.setup();
    const cands = gn.players.reduce((a, p) => a.concat(p.candidates || []), []);
    const baseNames = new Set(D.NEW_DUEL_BASE_NAMES || []);
    const all = cands.every((c) => newIds.has(c.id) || baseNames.has(c.name));
    const distinct = new Set(cands.map((c) => c.id)).size === cands.length;
    const count = cands.length === 8;
    t('T200', 'New1V1 池门控/候选', leak === 0 && all && distinct && count,
      `普通池泄漏=${leak}（应0），新池候选=${cands.length}（46将取4×2=8），全为新将/基础成员=${all}，不重复=${distinct}`);
  }

  // T201 袭爵：4爵；结束阶段按伤害数加爵；摸牌阶段移除1爵发动突袭
  {
    const g = game([{ name: '张虎乐綝', skills: ['j_xijue'], hp: 4 }, { name: '甲', hp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    p.marks.jue = 4;
    p.flags.damageCount = 2;
    await g.skillEndPhase(p);
    const gained = p.marks.jue === 6;
    tgt.hand = [C('sha', 'spade', 1)];
    g.deck = [C('tao', 'heart', 2)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /袭爵/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseOption' && /少摸的张数/.test(req.reason || '')) return '1';
      if (req.type === 'chooseTargets') return [1];
      return null;
    };
    await g.phaseDraw(p);
    const tuxi = p.marks.jue === 5 && p.hand.length === 2 && tgt.hand.length === 0;
    t('T201', '袭爵加爵/突袭', gained && tuxi,
      `结束阶段爵=${p.marks.jue === 5 ? 5 : (p.marks.jue + 1)}（加爵=${gained}），突袭后爵=${p.marks.jue}（应5），手牌=${p.hand.length}（应2）`);
  }

  // T202 识度：拼点赢→获得其所有手牌，交回一半（向下取整）
  {
    const g = game([{ name: '夏侯徽', skills: ['j_shidu'], hp: 3 }, { name: '甲', hp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    p.hand = [C('tao', 'heart', 12), C('shan', 'diamond', 2)];
    tgt.hand = [C('sha', 'spade', 3), C('shan', 'club', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseCards') {
        if (/拼点/.test(req.reason || '')) {
          if (pl === p) return [p.hand.find((c) => c.rank === 12).id];
          return [tgt.hand[0].id];
        }
        return [req.cards[0].id];
      }
      return null;
    };
    await g.useSkillAction(p, { skill: 'j_shidu', targets: [1] });
    t('T202', '识度拼点获得并交回一半', p.hand.length === 1 && tgt.hand.length === 1 && p.used.j_shidu === true,
      `夏侯徽手牌=${p.hand.length}（应1），甲手牌=${tgt.hand.length}（应1）`);
  }

  // T203 夷灭：失去1体力使伤害+X，伤害后目标回复X
  {
    const g = game([{ name: '司马师', skills: ['j_yimie'], hp: 3, maxHp: 4 }, { name: '甲', hp: 2, maxHp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    const tao = C('tao', 'heart', 5);
    tgt.hand = [tao];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /夷灭/.test(req.reason || '')) return 'yes';
      if (req.type === 'response' && req.need === 'tao') return { cardId: tao.id };
      return null;
    };
    await g.damage({ source: p, target: tgt, amount: 1, card: C('sha', 'spade', 6) });
    const dmgLog = g.logs.some((l) => /造成 2 点伤害/.test(l.text));
    t('T203', '夷灭加伤与回复', p.hp === 2 && tgt.hp === 2 && dmgLog,
      `司马师 hp=${p.hp}（应2），甲 hp=${tgt.hp}（应2），伤害日志为2点=${dmgLog}`);
  }

  // T204 泰然：结束阶段回复+摸至上限；出牌阶段开始失去/弃置
  {
    const g = game([{ name: '司马师', skills: ['j_yimie', 'j_tairan'], hp: 2, maxHp: 3 }]);
    const p = g.players[0];
    p.hand = [C('sha', 'spade', 1)];
    g.deck = [C('sha', 'spade', 2), C('shan', 'diamond', 3), C('tao', 'heart', 4)];
    g.handler = async () => null;
    await g.phaseEnd(p);
    const endOk = p.hp === 3 && p.hand.length === 3 && p.flags.tairan && p.flags.tairan.hp === 1;
    await g.skillPhaseHook(p, 'play');
    t('T204', '泰然回复/摸牌后回退', endOk && p.hp === 2 && p.hand.length === 1 && !p.flags.tairan,
      `结束阶段 hp=${endOk ? 3 : p.hp}/手牌=${endOk ? 3 : p.hand.length}，出牌阶段后 hp=${p.hp}（应2）/手牌=${p.hand.length}（应1）`);
  }

  // T205 筹伐：展示一张手牌后，其不同类型手牌视为【杀】
  {
    const g = game([{ name: '司马昭', skills: ['j_choufa'], hp: 3 }, { name: '甲', hp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    const sha = C('sha', 'spade', 1), guohe = C('guohe', 'club', 2), bagua = C('bagua', 'spade', 3);
    tgt.hand = [sha, guohe, bagua];
    g.handler = async (pl, req) => req.type === 'chooseCards' ? [sha.id] : null;
    await g.useSkillAction(p, { skill: 'j_choufa', targets: [1] });
    const opts = g.shaOptions(tgt);
    const ok = tgt.marks.choufaType === 'basic' && opts.some((o) => o.cardId === guohe.id) && opts.some((o) => o.cardId === bagua.id);
    t('T205', '筹伐异类型手牌视为杀', ok,
      `展示牌类型=${tgt.marks.choufaType}（basic），可用杀选项=${opts.length}（含原【杀】+2张视为杀）`);
  }

  // T206 宴戏：猜中得三张；猜错得选中一张
  {
    const g = game([{ name: '王元姬', skills: ['j_yanxi'], hp: 3 }, { name: '甲', hp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    tgt.hand = [C('tao', 'heart', 1)];
    g.deck = [C('sha', 'spade', 2), C('guohe', 'club', 3)];
    g.handler = async (pl, req) => (req.type === 'chooseOption' && /宴戏/.test(req.reason || '')) ? '2' : null;
    await g.useSkillAction(p, { skill: 'j_yanxi', targets: [1] });
    const right = p.hand.length === 3 && tgt.hand.length === 0 && g.deck.length === 0;
    const g2 = game([{ name: '王元姬', skills: ['j_yanxi'], hp: 3 }, { name: '甲', hp: 4 }]);
    const p2 = g2.players[0], t2 = g2.players[1];
    t2.hand = [C('tao', 'heart', 4)];
    g2.deck = [C('sha', 'spade', 5), C('guohe', 'club', 6)];
    g2.handler = async (pl, req) => (req.type === 'chooseOption' && /宴戏/.test(req.reason || '')) ? '0' : null;
    await g2.useSkillAction(p2, { skill: 'j_yanxi', targets: [1] });
    const wrong = p2.hand.length === 1;
    t('T206', '宴戏猜中得三/猜错得一张', right && wrong,
      `猜中得牌=${right}（手牌3），猜错得牌=${p2.hand.length}（应1）`);
  }

  // T207 三陈：摸三弃三，类型均不同→摸一、技能视为未发动、目标本回合禁用
  {
    const g = game([{ name: '杜预', skills: ['j_sanchen'], hp: 4 }, { name: '甲', hp: 4 }]);
    const p = g.players[0], tgt = g.players[1];
    g.deck = [C('sha', 'spade', 1), C('guohe', 'club', 2), C('bagua', 'spade', 3), C('tao', 'heart', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseCards') return req.cards.map((c) => c.id);
      return null;
    };
    await g.useSkillAction(p, { skill: 'j_sanchen', targets: [1] });
    const ok = tgt.hand.length === 1 && p.used.j_sanchen === false && p.flags.sanchenBanned && p.flags.sanchenBanned.indexOf(1) >= 0 && p.marks.sanchenCount === 1;
    t('T207', '三陈类型均不同重置/禁目标', ok,
      `甲手牌=${tgt.hand.length}（应1），视为未发动=${p.used.j_sanchen === false}，禁用目标=${!!(p.flags.sanchenBanned && p.flags.sanchenBanned.indexOf(1) >= 0)}`);
  }

  // T208 慧识：X=牌堆数个数位，获得一半（向下取整），其余置底
  {
    const g = game([{ name: '张春华', skills: ['j_huishi'], hp: 3 }]);
    const p = g.players[0];
    const deck = [];
    for (let i = 0; i < 13; i++) deck.push(C('sha', 'spade', (i % 13) + 1));
    g.deck = deck.slice();
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /慧识/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCards') return [req.cards[0].id];
      return null;
    };
    await g.phaseDraw(p);
    t('T208', '慧识观看X张获得一半', p.hand.length === 1 && g.deck.length === 12,
      `手牌=${p.hand.length}（应1），牌堆=${g.deck.length}（13→12）`);
  }

  // T209 朱雀羽扇/火杀/雷杀统一受出杀次数限制
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const p = g.players[0];
    const c = C('sha', 'spade', 7);
    p.equips.weapon = { id: 1, name: 'zhuque', type: 'equip', subtype: 'weapon', suit: 'spade', rank: 1, color: 'black' };
    p.hand = [c];
    p.flags = p.flags || {}; p.flags.tianyiWin = true;
    p.slashCount = 1;
    const blocked = g.cardActionFor(p, [c], 'huosha', 'zhuque') === null && g.cardActionFor(p, [c], 'leisha', null) === null;
    p.slashCount = 0;
    const allowed = !!g.cardActionFor(p, [c], 'huosha', 'zhuque');
    t('T209', '朱雀火杀受出杀次数限制', blocked && allowed, 'limit=1时火/雷杀=' + blocked + '，limit=0时火杀=' + allowed);
  }

  // T210 AI 不透视暗身份
  {
    const g = game([{ name: '主公', skills: [] }, { name: '反贼', skills: [] }, { name: '忠臣', skills: [] }, { name: '内奸', skills: [] }]);
    g.mode = '8p';
    g.players[0].role = 'lord'; g.players[0].revealed = true;
    g.players[1].role = 'rebel'; g.players[1].revealed = false;
    g.players[2].role = 'loyalist'; g.players[2].revealed = false;
    g.players[3].role = 'renegade'; g.players[3].revealed = false;
    const lordAI = new SGS.AI(g, 0, {});
    const rebelAI = new SGS.AI(g, 1, {});
    const noSnoop = !lordAI.isEnemy(g.players[1]) && !lordAI.isEnemy(g.players[2]) && !rebelAI.isEnemy(g.players[2]);
    const knownLord = rebelAI.isEnemy(g.players[0]);
    g.players[1].revealed = true;
    const revealed = lordAI.isEnemy(g.players[1]);
    t('T210', 'AI 不透视暗身份', noSnoop && knownLord && revealed, '未揭示不敌对=' + noSnoop + '，反贼识主=' + knownLord + '，揭示后敌对=' + revealed);
  }

  // T211 陆逊最后一张手牌装备触发连营
  {
    const g = game([{ name: '陆逊', skills: ['lianying'] }, { name: '甲', skills: [] }]);
    const p = g.players[0];
    const eq = C('qinggang', 'spade', 1);
    const draw = C('sha', 'club', 2);
    p.hand = [eq];
    g.deck = [draw];
    await g.useVirtualCard(p, [eq], 'qinggang', null, [], {});
    const ok = p.hand.length === 1 && p.hand[0].id === draw.id && g.logs.some((l) => /发动【连营】摸一张牌/.test(l.text));
    t('T211', '陆逊最后手牌装备触发连营', ok, '手牌=' + p.hand.length + '，连营日志=' + g.logs.some((l) => /连营/.test(l.text)));
  }

  // T212 1v1 先手只首回合少摸，不是每回合都少摸
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    g.mode = '1v1';
    const p = g.players[0];
    p.seat = 0; p.hand = []; p.skills = [];
    g.deck = []; for (let i = 0; i < 12; i++) g.deck.push(C('sha', 'spade', (i % 9) + 2, i));
    p.flags = {};
    await g.phaseDraw(p);
    const first = p.hand.length;
    p.hand = [];
    await g.phaseDraw(p);
    const second = p.hand.length;
    t('T212', '1v1 先手仅首回合少摸', first === 1 && second === 2, '首回合=' + first + '（应1），次回合=' + second + '（应2）');
  }

  // T213 张辽突袭偷走陆逊最后一张手牌，触发连营
  {
    const g = game([{ name: '张辽', skills: ['tuxi'] }, { name: '陆逊', skills: ['lianying'] }]);
    const p = g.players[0], q = g.players[1];
    p.hand = []; q.hand = [C('sha', 'club', 5)];
    g.deck = [C('tao', 'heart', 3)];
    g.handler = async (who, req) => req.type === 'chooseOption' ? 'yes' : req.type === 'chooseTargets' ? [1] : null;
    await g.phaseDraw(p);
    const ok = p.hand.length === 1 && q.hand.length === 1 && q.hand[0].name === 'tao' && g.logs.some((l) => /连营/.test(l.text));
    t('T213', '张辽突袭触发陆逊连营', ok, '张辽手牌=' + p.hand.length + '，陆逊手牌=' + q.hand.length + '，连营=' + g.logs.some((l) => /连营/.test(l.text)));
  }

  // T214 拼音卡名统一显示中文
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }]);
    const txt = g.cardText({ name: 'shandian', suit: 'spade', rank: 2 });
    t('T214', '拼音卡名归一化', txt.indexOf('闪电') >= 0 && txt.indexOf('shandian') < 0, txt);
  }

  // T215 暂停冻结（不变量 3/4）：调用 pause_check.js 驱动真实页面
  // 出牌阶段 + 求桃询问 × 后台暂停/手动暂停 keepAudio，共 28 条断言
  {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'pause_check.js'), '--json'], {
      encoding: 'utf8', cwd: path.join(__dirname, '..'), timeout: 180000,
    });
    let parsed = null;
    try {
      const lines = String(r.stdout || '').trim().split('\n');
      parsed = JSON.parse(lines[lines.length - 1]);
    } catch (e) { parsed = null; }
    const stderr = String(r.stderr || '');
    const missChrome = /Chrome 不存在/.test(stderr);
    const missServer = /本地服务不可用/.test(stderr);
    if (r.status === 2 && (missChrome || missServer)) {
      skip('T215', '暂停冻结（出牌/求桃 × 后台/手动）', missChrome ? '未找到 Chrome，跳过（不计失败）' : '本地 8899 服务不可用，跳过（不计失败）');
    } else {
      const ok = r.status === 0 && parsed && parsed.ok && parsed.total >= 28;
      t('T215', '暂停冻结（出牌/求桃 × 后台/手动）', ok,
        parsed ? ('pause_check ' + parsed.pass + '/' + parsed.total) : ('exit=' + r.status + ' ' + stderr.slice(0, 160)));
    }
  }

  // ================= 牌移动钩子回归 =================
  // T216 枭姬：装备被【过河拆桥】拆掉只应摸 2 张（pickCardFrom 已触发，调用方不得重复）
  {
    const g = game([{ name: '甲', skills: [] }, { name: '孙尚香', skills: ['xiaoji'], gender: 'female', hp: 3 }]);
    const p = g.players[0], q = g.players[1];
    q.equips.armor = C('bagua', 'club', 2);
    g.deck = [C('tao', 'heart', 1), C('tao', 'heart', 2), C('tao', 'heart', 3), C('tao', 'heart', 4)];
    g.handler = async (pl, req) => req.type === 'chooseCardFrom' ? { zone: 'equip', slot: 'armor' } : null;
    const vc = { id: 7001, name: 'guohe', type: 'trick', suit: 'spade', rank: 3, color: 'black', cards: [] };
    await g.resolveDismantle(p, vc, q, false);
    t('T216', '枭姬-过拆装备只触发一次', q.hand.length === 2, '摸牌=' + q.hand.length + '（应2）');
  }

  // T217 枭姬：挑衅弃置装备只应摸 2 张
  {
    const g = game([{ name: '张辽', skills: ['tiaoxin'] }, { name: '孙尚香', skills: ['xiaoji'], gender: 'female', hp: 3 }]);
    const p = g.players[0], q = g.players[1];
    q.equips.weapon = C('qinglong', 'spade', 5);
    g.deck = [C('tao', 'heart', 1), C('tao', 'heart', 2), C('tao', 'heart', 3), C('tao', 'heart', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'response') return null;
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'weapon' };
      return null;
    };
    await g.useSkillAction(p, { skill: 'tiaoxin', targets: [1] });
    t('T217', '枭姬-挑衅装备只触发一次', q.hand.length === 2, '摸牌=' + q.hand.length + '（应2）');
  }

  // T218 枭姬：趫猛弃置非坐骑装备只应摸 2 张
  {
    const g = game([{ name: '公孙瓒', skills: ['qiaomeng'], hp: 4 }, { name: '孙尚香', skills: ['xiaoji'], gender: 'female', hp: 3 }]);
    const p = g.players[0], q = g.players[1];
    q.equips.armor = C('bagua', 'club', 2);
    g.deck = [C('tao', 'heart', 1), C('tao', 'heart', 2), C('tao', 'heart', 3), C('tao', 'heart', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /趫猛/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'armor' };
      return null;
    };
    await g.damage({ source: p, target: q, amount: 1, card: C('sha', 'spade', 7) });
    t('T218', '枭姬-趫猛装备只触发一次', q.hand.length === 2, '摸牌=' + q.hand.length + '（应2）');
  }

  // T219 枭姬：刚烈（界）黑判定弃装备只应摸 2 张
  {
    const g = game([{ name: '夏侯惇', skills: ['j_ganglie'], hp: 4 }, { name: '孙尚香', skills: ['xiaoji'], gender: 'female', hp: 3 }]);
    const p = g.players[0], q = g.players[1];
    q.equips.armor = C('bagua', 'club', 2);
    g.deck = [C('tao', 'heart', 1), C('tao', 'heart', 2), C('tao', 'heart', 3), C('sha', 'spade', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /刚烈/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'armor' };
      return null;
    };
    await g.damage({ source: q, target: p, amount: 1 });
    t('T219', '枭姬-刚烈装备只触发一次', q.hand.length === 2, '摸牌=' + q.hand.length + '（应2）');
  }

  // T220 连营：仁德交出最后手牌应触发
  {
    const g = game([{ name: '刘备', skills: ['rende', 'lianying'] }, { name: '甲' }]);
    const p = g.players[0];
    const c = C('sha', 'spade', 1);
    p.hand = [c];
    g.deck = [C('tao', 'heart', 2)];
    g.handler = async () => null;
    await g.useSkillAction(p, { skill: 'rende', cards: [c.id], targets: [1] });
    t('T220', '连营-仁德交出最后手牌', p.hand.length === 1 && g.logs.some((l) => /连营/.test(l.text)), '手牌=' + p.hand.length + '（应1）');
  }

  // T221 连营：反间交出最后手牌应触发
  {
    const g = game([{ name: '周瑜', skills: ['fanjian', 'lianying'] }, { name: '甲' }]);
    const p = g.players[0];
    const c = C('sha', 'spade', 1);
    p.hand = [c];
    g.deck = [C('tao', 'heart', 2)];
    g.handler = async (pl, req) => req.type === 'chooseOption' ? 'spade' : null;
    await g.useSkillAction(p, { skill: 'fanjian', cards: [c.id], targets: [1] });
    t('T221', '连营-反间交出最后手牌', p.hand.length === 1 && g.logs.some((l) => /连营/.test(l.text)), '手牌=' + p.hand.length + '（应1）');
  }

  // T222 连营：蛊惑最后一张手牌应触发
  {
    const g = game([{ name: '于吉', skills: ['guhuo', 'lianying'] }, { name: '甲' }]);
    const p = g.players[0];
    const c = C('tao', 'heart', 3);
    p.hand = [c];
    g.deck = [C('tao', 'heart', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /质疑/.test(req.reason || '')) return 'no';
      return null;
    };
    await g.useSkillAction(p, { skill: 'guhuo', cards: [c.id], declare: 'tao', targets: [] });
    t('T222', '连营-蛊惑最后手牌', p.hand.length === 1 && g.logs.some((l) => /连营/.test(l.text)), '手牌=' + p.hand.length + '（应1）');
  }

  // T223 连营：丈八最后两张手牌当杀应触发
  {
    const g = game([{ name: '甲', skills: ['zhangba', 'lianying'] }, { name: '乙' }]);
    const p = g.players[0];
    const c1 = C('sha', 'spade', 1), c2 = C('shan', 'club', 2);
    p.hand = [c1, c2];
    g.deck = [C('tao', 'heart', 3)];
    g.handler = async () => null;
    await g.useSkillAction(p, { skill: 'zhangba', cards: [c1.id, c2.id], targets: [1] });
    t('T223', '连营-丈八最后两张手牌', p.hand.length === 1 && g.logs.some((l) => /连营/.test(l.text)), '手牌=' + p.hand.length + '（应1）');
  }

  // T224 连营：火攻弃置最后手牌应触发
  {
    const g = game([{ name: '甲', skills: ['huogong', 'lianying'] }, { name: '乙' }]);
    const p = g.players[0], q = g.players[1];
    p.hand = [C('tao', 'heart', 1)];
    q.hand = [C('sha', 'heart', 2)];
    g.deck = [C('tao', 'heart', 3)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      if (req.type === 'chooseHiddenCard') return 0;
      if (req.type === 'chooseCards') return [req.cards[0].id];
      return null;
    };
    const vc = { id: 7002, name: 'huogong', type: 'trick', suit: 'heart', rank: 9, color: 'red', cards: [] };
    await g.resolveVirtualCard(p, vc, [q], {});
    t('T224', '连营-火攻弃最后手牌', p.hand.length === 1 && g.logs.some((l) => /连营/.test(l.text)), '手牌=' + p.hand.length + '（应1）');
  }

  // T225 连营：反馈获得陆逊最后一张手牌应触发
  {
    const g = game([{ name: '司马懿', skills: ['fankui'], hp: 4 }, { name: '陆逊', skills: ['lianying'], hp: 4 }]);
    const p = g.players[0], q = g.players[1];
    q.hand = [C('tao', 'heart', 1)];
    g.deck = [C('tao', 'heart', 2)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption') return 'yes';
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      if (req.type === 'chooseHiddenCard') return 0;
      return null;
    };
    await g.damage({ source: q, target: p, amount: 1 });
    t('T225', '连营-反馈获得最后手牌', q.hand.length === 1 && g.logs.some((l) => /连营/.test(l.text)), '陆逊手牌=' + q.hand.length + '（应1）');
  }

  // T226 连营：识度获得目标全部手牌应触发目标连营
  {
    const g = game([{ name: '夏侯徽', skills: ['j_shidu'] }, { name: '陆逊', skills: ['lianying'], hp: 4 }]);
    const p = g.players[0], q = g.players[1];
    p.hand = [C('tao', 'heart', 12), C('shan', 'diamond', 2)];
    q.hand = [C('sha', 'spade', 3), C('shan', 'club', 4)];
    g.deck = [C('tao', 'heart', 5)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseCards') {
        if (/拼点/.test(req.reason || '')) return pl === p ? [p.hand.find((c) => c.rank === 12).id] : [q.hand[0].id];
        return [req.cards[0].id];
      }
      return null;
    };
    await g.useSkillAction(p, { skill: 'j_shidu', targets: [1] });
    t('T226', '连营-识度获得全部手牌', g.logs.some((l) => /连营/.test(l.text)), '连营日志=' + g.logs.some((l) => /连营/.test(l.text)));
  }

  // T227 连营：宴戏取走目标最后一张手牌应触发目标连营
  {
    const g = game([{ name: '王元姬', skills: ['j_yanxi'], hp: 3 }, { name: '陆逊', skills: ['lianying'], hp: 4 }]);
    const p = g.players[0], q = g.players[1];
    q.hand = [C('tao', 'heart', 1)];
    g.deck = [C('sha', 'spade', 2), C('guohe', 'club', 3), C('tao', 'heart', 4)];
    g.handler = async (pl, req) => req.type === 'chooseOption' ? '2' : null;
    await g.useSkillAction(p, { skill: 'j_yanxi', targets: [1] });
    t('T227', '连营-宴戏取走最后手牌', g.logs.some((l) => /连营/.test(l.text)), '连营日志=' + g.logs.some((l) => /连营/.test(l.text)));
  }

  // T228 连营：清俭交出最后手牌应触发
  {
    const g = game([{ name: '夏侯惇', skills: ['j_qingjian', 'lianying'] }, { name: '甲' }]);
    const p = g.players[0];
    const c = C('sha', 'spade', 1);
    p.hand = [c];
    g.deck = [C('tao', 'heart', 2)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /清俭/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCards') return [req.cards[0].id];
      if (req.type === 'chooseTargets') return [1];
      return null;
    };
    await g.afterCardGainHook(p, [c]);
    t('T228', '连营-清俭交出最后手牌', p.hand.length === 1 && g.logs.some((l) => /连营/.test(l.text)), '手牌=' + p.hand.length + '（应1）');
  }

  // T229 连营：界遗计把摸到的最后两张手牌给出后应触发
  {
    const g = game([{ name: '郭嘉', skills: ['j_yiji', 'lianying'], hp: 4 }, { name: '甲' }]);
    const p = g.players[0], q = g.players[1];
    g.deck = [C('sha', 'spade', 1), C('shan', 'diamond', 2), C('tao', 'heart', 3)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /遗计/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCards') return req.cards.map((c) => c.id);
      if (req.type === 'chooseTargets') return [1];
      return null;
    };
    await g.damage({ source: q, target: p, amount: 1 });
    t('T229', '连营-界遗计交出最后手牌', g.logs.some((l) => /连营/.test(l.text)), '连营日志=' + g.logs.some((l) => /连营/.test(l.text)));
  }

  // T230 好施交给目标牌应触发目标的获得牌钩子（清俭）
  {
    const g = game([{ name: '鲁肃', skills: ['haoshi'], hp: 3 }, { name: '夏侯惇', skills: ['j_qingjian'], hp: 4 }, { name: '甲', hp: 4 }]);
    const p = g.players[0];
    p.hand = [C('sha', 'spade', 1), C('sha', 'spade', 2)];
    g.deck = [C('tao', 'heart', 11), C('tao', 'heart', 12), C('shan', 'diamond', 13), C('shan', 'diamond', 14), C('sha', 'club', 5), C('sha', 'club', 6)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseCards') return req.cards.slice(0, req.min || 1).map((c) => c.id);
      if (req.type === 'chooseTargets') return [2];
      if (req.type === 'chooseOption') return 'yes';
      return null;
    };
    await g.skillDrawPhase(p);
    await new Promise((r) => setTimeout(r, 30));
    const qjAsks = g._asks.filter((r) => r.type === 'chooseOption' && /清俭/.test(r.reason || '')).length;
    t('T230', '好施交牌触发清俭获得钩子', g.logs.some((l) => /清俭/.test(l.text)) && qjAsks === 1, '清俭日志=' + g.logs.some((l) => /清俭/.test(l.text)) + '，清俭询问=' + qjAsks + '（应1）');
  }

  // T231 基础遗计经 distributeCards 交出最后手牌应触发连营
  {
    const g = game([{ name: '郭嘉', skills: ['yiji', 'lianying'], hp: 4 }, { name: '甲' }]);
    const p = g.players[0], q = g.players[1];
    g.deck = [C('sha', 'spade', 1), C('shan', 'diamond', 2), C('tao', 'heart', 3)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption') return 'yes';
      if (req.type === 'distribute') return (req.cards || []).map((c) => ({ cardId: c.id, seat: 1 }));
      return null;
    };
    await g.damage({ source: q, target: p, amount: 1 });
    t('T231', '连营-基础遗计交出最后手牌', p.hand.length === 1 && g.logs.some((l) => /连营/.test(l.text)), '郭嘉手牌=' + p.hand.length + '（应1）');
  }

  // T235 过河拆桥让邓艾失去最后手牌应触发屯田（回合外失去牌）
  {
    const g = game([{ name: '甲', skills: [] }, { name: '邓艾', skills: ['tuntian'], hp: 4 }]);
    const p = g.players[0], q = g.players[1];
    q.hand = [C('tao', 'heart', 2)];
    g.currentSeat = 0;
    g.deck = [C('tao', 'heart', 3), C('sha', 'spade', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      if (req.type === 'chooseHiddenCard') return 0;
      return null;
    };
    const vc = { id: 7003, name: 'guohe', type: 'trick', suit: 'spade', rank: 3, color: 'black', cards: [] };
    await g.resolveDismantle(p, vc, q, false);
    t('T235', '过拆丢最后手牌触发屯田', q.marks.tian === 1 && g.logs.some((l) => /屯田/.test(l.text)), '田=' + (q.marks.tian || 0) + '（应1），屯田日志=' + g.logs.some((l) => /屯田/.test(l.text)));
  }

  // ================= 第二轮规则口径（手牌/装备离开必须钩；判定区不钩；置入装备不算获得） =================
  // T236 涅槃弃置所有牌：手牌、装备分别触发连营/枭姬
  {
    const g = game([{ name: '庞统', skills: ['niepan', 'lianying', 'xiaoji'], hp: 0 }]);
    const p = g.players[0];
    p.hand = [C('sha', 'spade', 1)];
    p.equips.armor = C('bagua', 'club', 2);
    g.deck = [C('tao', 'heart', 3), C('tao', 'heart', 4), C('tao', 'heart', 5), C('tao', 'heart', 6), C('tao', 'heart', 7)];
    g.handler = async (pl, req) => req.type === 'chooseOption' && /涅槃/.test(req.reason || '') ? 'yes' : null;
    await g.dying(p, null);
    t('T236', '涅槃分别触发连营/枭姬', g.logs.some((l) => /连营/.test(l.text)) && g.logs.some((l) => /枭姬/.test(l.text)),
      '连营=' + g.logs.some((l) => /连营/.test(l.text)) + '，枭姬=' + g.logs.some((l) => /枭姬/.test(l.text)));
  }

  // T237 主公误杀忠臣：手牌/装备分别触发连营/枭姬
  {
    const g = game([{ name: '孙尚香', skills: ['xiaoji', 'lianying'], gender: 'female', hp: 3 }, { name: '忠臣', role: 'loyalist' }, { name: '甲' }]);
    const p = g.players[0], dead = g.players[1];
    p.role = 'lord';
    p.hand = [C('sha', 'spade', 1)];
    p.equips.armor = C('bagua', 'club', 2);
    g.deck = [C('tao', 'heart', 3), C('tao', 'heart', 4), C('tao', 'heart', 5)];
    g.handler = async () => null;
    await g.kill(dead, p);
    t('T237', '误杀忠臣分别触发连营/枭姬', g.logs.some((l) => /连营/.test(l.text)) && g.logs.some((l) => /枭姬/.test(l.text)),
      '连营=' + g.logs.some((l) => /连营/.test(l.text)) + '，枭姬=' + g.logs.some((l) => /枭姬/.test(l.text)));
  }

  // T238 巧变移动装备：原持有者枭姬触发一次；置入目标装备不算获得（不触发清俭）
  {
    const g = game([{ name: '张郃', skills: ['qiaobian'] }, { name: '孙尚香', skills: ['xiaoji'], gender: 'female', hp: 3 }, { name: '夏侯惇', skills: ['j_qingjian'] }]);
    const p = g.players[0], q = g.players[1], dest = g.players[2];
    const bagua = C('bagua', 'club', 2);
    q.equips.armor = bagua;
    g.deck = [C('tao', 'heart', 3), C('tao', 'heart', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseTargets') return req.reason && /移动其场上牌/.test(req.reason) ? [1] : [2];
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'armor' };
      return null;
    };
    await g.qiaobianMove(p);
    await new Promise((r) => setTimeout(r, 20));
    const xiao = q.hand.length === 2;
    const moved = dest.equips.armor && dest.equips.armor.id === bagua.id;
    const noQing = !g.logs.some((l) => /清俭/.test(l.text));
    t('T238', '巧变装备：原主枭姬、目标不触发清俭', xiao && moved && noQing,
      '原主摸牌=' + q.hand.length + '（应2），装备已移动=' + !!moved + '，无清俭=' + noQing);
  }

  // T239 巧变移动判定区牌：不触发连营
  {
    const g = game([{ name: '张郃', skills: ['qiaobian'] }, { name: '陆逊', skills: ['lianying'], hp: 3 }, { name: '甲' }]);
    const p = g.players[0], q = g.players[1];
    q.judges.push(C('lebu', 'heart', 6));
    g.deck = [C('tao', 'heart', 3)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseTargets') return req.reason && /移动其场上牌/.test(req.reason) ? [1] : [2];
      if (req.type === 'chooseCardFrom') return { zone: 'judge', cardId: q.judges[0].id };
      return null;
    };
    await g.qiaobianMove(p);
    t('T239', '巧变判定区牌不触发连营', !g.logs.some((l) => /连营/.test(l.text)) && q.judges.length === 0, '连营=' + g.logs.some((l) => /连营/.test(l.text)) + '，原判定区=' + q.judges.length);
  }

  // T240 pickCardFrom 判定区：不触发连营
  {
    const g = game([{ name: '甲' }, { name: '陆逊', skills: ['lianying'], hp: 3 }]);
    const p = g.players[0], q = g.players[1];
    q.judges.push(C('lebu', 'heart', 7));
    g.deck = [C('tao', 'heart', 3)];
    g.handler = async (pl, req) => req.type === 'chooseCardFrom' ? { zone: 'judge', cardId: q.judges[0].id } : null;
    const c = await g.pickCardFrom(q, p, { zones: ['judge'] });
    t('T240', 'pickCardFrom 判定区不触发连营', !!c && !g.logs.some((l) => /连营/.test(l.text)), '取牌=' + !!c + '，连营=' + g.logs.some((l) => /连营/.test(l.text)));
  }

  // T241 直谏置入装备不触发清俭
  {
    const g = game([{ name: '张昭张纮', skills: ['zhijian'], hp: 3 }, { name: '夏侯惇', skills: ['j_qingjian'], hp: 4 }, { name: '甲' }]);
    const p = g.players[0];
    const bagua = C('bagua', 'club', 2);
    p.hand = [bagua];
    g.handler = async (pl, req) => req.type === 'chooseTargets' ? [1] : (req.type === 'chooseCards' ? [req.cards[0].id] : null);
    await g.useSkillAction(p, { skill: 'zhijian', cards: [bagua.id], targets: [1] });
    await new Promise((r) => setTimeout(r, 20));
    t('T241', '直谏置入装备不触发清俭', !g.logs.some((l) => /清俭/.test(l.text)), '清俭=' + g.logs.some((l) => /清俭/.test(l.text)));
  }

  // T242 界结姻置入装备不触发清俭
  {
    const g = game([{ name: '孙尚香', gender: 'female', skills: ['j_jieyin'], hp: 3 }, { name: '夏侯惇', skills: ['j_qingjian'], hp: 3 }, { name: '甲' }]);
    const p = g.players[0], q = g.players[1];
    const bagua = C('bagua', 'club', 2);
    p.equips.armor = bagua;
    g.handler = async (pl, req) => req.type === 'chooseOption' && /结姻/.test(req.reason || '') ? 'equip' : null;
    await g.useSkillAction(p, { skill: 'j_jieyin', targets: [1] });
    await new Promise((r) => setTimeout(r, 20));
    t('T242', '界结姻置入装备不触发清俭', !g.logs.some((l) => /清俭/.test(l.text)), '清俭=' + g.logs.some((l) => /清俭/.test(l.text)));
  }

  // T243 猛进弃装备：枭姬只触发一次
  {
    const g = game([{ name: '庞德', skills: ['mengjin'], hp: 4 }, { name: '孙尚香', skills: ['xiaoji'], gender: 'female', hp: 3 }]);
    const p = g.players[0], q = g.players[1];
    q.equips.armor = C('bagua', 'club', 2);
    q.hand = [C('shan', 'diamond', 8)];
    g.deck = [C('tao', 'heart', 3), C('tao', 'heart', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'response' && req.need === 'shan') return { cardId: req.options[0].cardId };
      if (req.type === 'chooseOption' && /猛进/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'armor' };
      return null;
    };
    await g.resolveSlash(p, { id: 8001, name: 'sha', type: 'basic', suit: 'spade', rank: 7, color: 'black', cards: [] }, [q]);
    t('T243', '猛进弃装备枭姬只触发一次', q.hand.length === 2, '摸牌=' + q.hand.length + '（应2）');
  }

  // T244 寒冰剑弃两件装备：枭姬各一次共4
  {
    const g = game([{ name: '庞德', hp: 4 }, { name: '孙尚香', skills: ['xiaoji'], gender: 'female', hp: 3 }]);
    const p = g.players[0], q = g.players[1];
    p.equips.weapon = C('hanbing', 'spade', 5);
    q.equips.armor = C('bagua', 'club', 2);
    q.equips.weapon = C('qinglong', 'spade', 4);
    q.hand = [C('tao', 'heart', 9)];
    g.deck = [C('tao', 'heart', 3), C('tao', 'heart', 4), C('tao', 'heart', 6), C('tao', 'heart', 7)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /寒冰剑/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCardFrom') {
        const eq = (req.choices || []).filter((c) => c.zone === 'equip');
        return eq.length ? { zone: 'equip', slot: eq[0].slot } : { zone: 'hand' };
      }
      return null;
    };
    await g.resolveSlash(p, { id: 8002, name: 'sha', type: 'basic', suit: 'spade', rank: 8, color: 'black', cards: [] }, [q]);
    t('T244', '寒冰剑两装备枭姬共4', q.hand.length === 5, '摸牌=' + q.hand.length + '（原手牌1+枭姬4=5）');
  }

  // T245 聚众弃装备：枭姬只触发一次
  {
    const g = game([{ name: '农民', skills: ['juzhong'] }, { name: '孙尚香', skills: ['xiaoji'], gender: 'female', hp: 3 }, { name: '队友', role: 'farmer' }], { mode: 'ddz' });
    const p = g.players[0], q = g.players[1], user = g.players[2];
    p.role = 'farmer'; p.skills = ['juzhong']; p.hand = [C('shan', 'heart', 2)];
    q.equips.armor = C('bagua', 'club', 2);
    g.deck = [C('tao', 'heart', 3), C('tao', 'heart', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /聚众/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCards') return [req.cards[0].id];
      if (req.type === 'chooseTargets') return [1];
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'armor' };
      return null;
    };
    await g.juzhongAfterShan(user);
    t('T245', '聚众弃装备枭姬只触发一次', q.hand.length === 2, '摸牌=' + q.hand.length + '（应2）');
  }

  // T246 涯角弃装备：枭姬只触发一次
  {
    const g = game([{ name: '孙尚香', skills: ['xiaoji'], gender: 'female', hp: 3 }, { name: '赵云', skills: ['j_yajiao'], hp: 4 }]);
    const q = g.players[0], p = g.players[1];
    q.equips.armor = C('bagua', 'club', 2);
    g.currentSeat = 0;
    g.deck = [C('tao', 'heart', 4), C('tao', 'heart', 5), C('guohe', 'spade', 3)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /涯角/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseTargets') return [0];
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'armor' };
      return null;
    };
    await g.yajiaoTrigger(p, C('sha', 'spade', 1));
    t('T246', '涯角弃装备枭姬只触发一次', q.hand.length === 2, '摸牌=' + q.hand.length + '（应2）');
  }

  // T247 除疠弃装备：枭姬只触发一次
  {
    const g = game([{ name: '华佗', skills: ['jijiu', 'j_chuli'], hp: 3 }, { name: '孙尚香', skills: ['xiaoji'], gender: 'female', hp: 3 }, { name: '甲' }]);
    const p = g.players[0], q = g.players[1];
    p.hand = [C('sha', 'spade', 1), C('tao', 'heart', 2)];
    q.equips.armor = C('bagua', 'club', 2);
    g.deck = [C('tao', 'heart', 3), C('tao', 'heart', 4)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseCards') return [req.cards[0].id];
      if (req.type === 'chooseCardFrom') return { zone: 'equip', slot: 'armor' };
      return null;
    };
    await g.useSkillAction(p, { skill: 'j_chuli', cards: [], targets: [1] });
    t('T247', '除疠弃装备枭姬只触发一次', q.hand.length === 2, '摸牌=' + q.hand.length + '（应2）');
  }

  // T248 烈刃获得目标最后手牌：目标连营
  {
    const g = game([{ name: '祝融', skills: ['lieren'], hp: 4 }, { name: '陆逊', skills: ['lianying'], hp: 4 }]);
    const p = g.players[0], q = g.players[1];
    p.hand = [C('tao', 'heart', 12), C('shan', 'diamond', 2)];
    q.hand = [C('sha', 'spade', 3), C('shan', 'club', 4)];
    g.deck = [C('tao', 'heart', 5)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseCards') return pl === p ? [p.hand.find((c) => c.rank === 12).id] : [q.hand[0].id];
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      if (req.type === 'chooseHiddenCard') return 0;
      return null;
    };
    await g.resolveSlash(p, { id: 8003, name: 'sha', type: 'basic', suit: 'spade', rank: 9, color: 'black', cards: [] }, [q]);
    t('T248', '烈刃获得最后手牌触发连营', g.logs.some((l) => /连营/.test(l.text)), '连营=' + g.logs.some((l) => /连营/.test(l.text)));
  }

  // T249 利驭获得目标最后手牌：目标连营
  {
    const g = game([{ name: '吕布', skills: ['wushuang', 'j_liyu'], hp: 4 }, { name: '陆逊', skills: ['lianying'], hp: 4 }, { name: '甲' }]);
    const p = g.players[0], q = g.players[1];
    q.hand = [C('tao', 'heart', 1)];
    g.deck = [C('tao', 'heart', 2)];
    g.handler = async (pl, req) => {
      if (req.type === 'chooseOption' && /利驭/.test(req.reason || '')) return 'yes';
      if (req.type === 'chooseCardFrom') return { zone: 'hand' };
      if (req.type === 'chooseHiddenCard') return 0;
      return null;
    };
    await g.damage({ source: p, target: q, amount: 1, card: C('sha', 'spade', 3) });
    t('T249', '利驭获得最后手牌触发连营', g.logs.some((l) => /连营/.test(l.text)), '连营=' + g.logs.some((l) => /连营/.test(l.text)));
  }

  // ================= AI 主动技（识度/筹伐/宴戏/三陈） =================
  // T250 识度：敌方手牌多且己方有高点，AI 应发动
  {
    const g = game([{ name: '夏侯徽', skills: ['j_shidu'], hp: 3 }, { name: '甲', role: 'rebel', hp: 4 }], { mode: '1v1' });
    const p = g.players[0], q = g.players[1];
    p.role = 'loyalist';
    p.hand = [C('tao', 'heart', 12), C('shan', 'diamond', 2)];
    q.hand = [C('sha', 'spade', 3), C('sha', 'club', 4), C('shan', 'heart', 5), C('tao', 'diamond', 6), C('sha', 'heart', 7)];
    g.currentSeat = 0; g.phase = 'play';
    const ai = new SGS.AI(g, 0, { speed: 0, aiLevel: 'normal' });
    const ans = await ai.decide({ type: 'play', player: p, actions: g.buildPlayActions(p) });
    t('T250', 'AI 使用识度', ans && ans.kind === 'skill' && ans.skill === 'j_shidu', 'AI=' + (ans && ans.kind) + '/' + (ans && ans.skill));
  }

  // T251 筹伐：敌方有手牌，AI 应发动
  {
    const g = game([{ name: '司马昭', skills: ['j_choufa'], hp: 3 }, { name: '甲', role: 'rebel', hp: 4 }], { mode: '1v1' });
    const p = g.players[0], q = g.players[1];
    p.role = 'loyalist';
    p.hand = [C('shan', 'diamond', 2)];
    q.hand = [C('sha', 'spade', 3), C('sha', 'club', 4), C('shan', 'heart', 5)];
    g.currentSeat = 0; g.phase = 'play';
    const ai = new SGS.AI(g, 0, { speed: 0, aiLevel: 'normal' });
    const ans = await ai.decide({ type: 'play', player: p, actions: g.buildPlayActions(p) });
    t('T251', 'AI 使用筹伐', ans && ans.kind === 'skill' && ans.skill === 'j_choufa', 'AI=' + (ans && ans.kind) + '/' + (ans && ans.skill));
  }

  // T252 宴戏：敌方有手牌，AI 应发动
  {
    const g = game([{ name: '王元姬', skills: ['j_yanxi'], hp: 3 }, { name: '甲', role: 'rebel', hp: 4 }], { mode: '1v1' });
    const p = g.players[0], q = g.players[1];
    p.role = 'loyalist';
    p.hand = [C('shan', 'diamond', 2)];
    q.hand = [C('sha', 'spade', 3), C('tao', 'heart', 4)];
    g.deck = [C('tao', 'heart', 5), C('sha', 'club', 6)];
    g.currentSeat = 0; g.phase = 'play';
    const ai = new SGS.AI(g, 0, { speed: 0, aiLevel: 'normal' });
    const ans = await ai.decide({ type: 'play', player: p, actions: g.buildPlayActions(p) });
    t('T252', 'AI 使用宴戏', ans && ans.kind === 'skill' && ans.skill === 'j_yanxi', 'AI=' + (ans && ans.kind) + '/' + (ans && ans.skill));
  }

  // T253 三陈：己方手牌少/质量差，AI 应发动并选自己
  {
    const g = game([{ name: '杜预', skills: ['j_sanchen'], hp: 4 }, { name: '甲', role: 'rebel', hp: 4 }], { mode: '1v1' });
    const p = g.players[0], q = g.players[1];
    p.role = 'loyalist';
    p.hand = [C('shan', 'diamond', 2), C('shan', 'heart', 3)];
    q.hand = [C('sha', 'spade', 4), C('sha', 'club', 5)];
    g.currentSeat = 0; g.phase = 'play';
    const ai = new SGS.AI(g, 0, { speed: 0, aiLevel: 'normal' });
    const ans = await ai.decide({ type: 'play', player: p, actions: g.buildPlayActions(p) });
    t('T253', 'AI 使用三陈并选自己', ans && ans.kind === 'skill' && ans.skill === 'j_sanchen' && ans.targets && ans.targets[0] === 0, 'AI=' + (ans && ans.kind) + '/' + (ans && ans.skill) + ' targets=' + JSON.stringify(ans && ans.targets));
  }

  // T254 存档一致性：手牌顺序/装备/判定/牌堆/弃牌/回合/座位/状态/标记/revealed/duelFirstDraw
  {
    const g = game([
      { name: '甲', role: 'lord', skills: ['rende'], hp: 3, maxHp: 4 },
      { name: '乙', role: 'loyalist', skills: [], hp: 4 },
      { name: '丙', role: 'rebel', skills: [], hp: 2 },
    ], { mode: '8p' });
    const p = g.players[0];
    p.isHuman = true; g.humanSeat = 0;
    p.hand = [C('sha', 'spade', 7), C('shan', 'heart', 2), C('tao', 'diamond', 3)];
    p.equips = { weapon: C('qinggang', 'spade', 6), armor: C('bagua', 'club', 2), offhorse: C('chitu', 'heart', 5), defhorse: C('dilu', 'club', 5) };
    p.judges = [C('lebu', 'spade', 3), C('bingliang', 'club', 4)];
    p.marks = { buqu: 2, tian: 1, jue: 1, choufaType: 'sha', sanchenCount: 2, huashen: { id: 7, name: '化身' }, exile: 1 };
    p.chained = true; p.flipped = true; p.revealed = true; p.duelFirstDraw = true;
    g.players[1].hand = [C('wuzhong', 'heart', 7)];
    g.players[2].hand = [];
    g.deck = [C('sha', 'club', 8), C('shan', 'diamond', 9), C('tao', 'heart', 10)];
    g.discardPile = [C('guohe', 'spade', 3), C('shunshou', 'diamond', 4)];
    g.currentSeat = 2; g.turnCount = 7; g.lordSeat = 0; g.phase = 'play';
    g.logs = [{ text: '第 7 回合', type: 'turn', turn: 7 }];
    g.stats = { damage: { 0: 3 }, kills: { 0: 1 } };
    const snap = JSON.parse(JSON.stringify(g.snapshot()));
    const g2 = game([{ name: 'x' }, { name: 'y' }, { name: 'z' }], { mode: '8p' });
    g2.restore(JSON.parse(JSON.stringify(snap)));
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const checks = [
      eq(g2.mode, '8p'), eq(g2.players.length, 3),
      eq(g2.players[0].hand, p.hand), eq(g2.players[0].equips, p.equips),
      eq(g2.players[0].judges, p.judges), eq(g2.players[0].marks, p.marks),
      g2.players[0].chained === true && g2.players[0].flipped === true && g2.players[0].revealed === true && g2.players[0].duelFirstDraw === true,
      eq(g2.deck, g.deck), eq(g2.discardPile, g.discardPile),
      g2.currentSeat === 2 && g2.turnCount === 7 && g2.lordSeat === 0,
      eq(g2.stats, g.stats),
    ];
    t('T254', '存档全字段一致性', checks.every(Boolean),
      '字段通过 ' + checks.filter(Boolean).length + '/' + checks.length + '；手牌=' + g2.players[0].hand.length + ' 装备=' + Object.values(g2.players[0].equips).filter(Boolean).length + ' 判定=' + g2.players[0].judges.length + ' 牌堆=' + g2.deck.length + ' 回合=' + g2.turnCount);
  }

  // T255 RNG 状态写入快照并恢复：读档后的随机序列与连续游玩一致
  {
    const g = new SGS.Game({ mode: '1v1', seed: 123456789, humanSeat: 0, agents: [], onUpdate() {} });
    g.players = [P({ name: '甲' }, 0), P({ name: '乙', role: 'rebel' }, 1)];
    g.started = true; g.pause = async () => {};
    for (let i = 0; i < 7; i++) g.rand(1000);
    const snap = JSON.parse(JSON.stringify(g.snapshot()));
    const expected = [];
    for (let i = 0; i < 20; i++) expected.push(g.rand(1000));
    const g2 = new SGS.Game({ mode: '1v1', seed: snap.seed, humanSeat: 0, agents: [], onUpdate() {} });
    g2.players = [P({ name: '甲' }, 0), P({ name: '乙', role: 'rebel' }, 1)];
    g2.started = true; g2.pause = async () => {};
    g2.restore(JSON.parse(JSON.stringify(snap)));
    const actual = [];
    for (let i = 0; i < 20; i++) actual.push(g2.rand(1000));
    t('T255', 'RNG 状态读档后延续', snap.rngState != null && JSON.stringify(actual) === JSON.stringify(expected),
      'rngState=' + snap.rngState + '，前 5 个随机数=' + actual.slice(0, 5).join(',') + '（期望 ' + expected.slice(0, 5).join(',') + '）');
  }

  // T256 六种模式的快照/恢复
  {
    const modes = [['8p', 8], ['5p', 5], ['1v1', 2], ['2v2', 4], ['3v3', 6], ['ddz', 3]];
    const bad = [];
    const details = [];
    for (const [mode, count] of modes) {
      const g = new SGS.Game({ mode, seed: 77, humanSeat: 0, agents: [], onUpdate() {} });
      g.players = Array.from({ length: count }, (_, i) => P({ name: 'P' + i, role: i === 0 ? (mode === 'ddz' ? 'landlord' : 'lord') : (mode === 'ddz' ? 'farmer' : 'rebel') }, i));
      g.started = true; g.pause = async () => {};
      g.turnCount = 3 + count; g.currentSeat = count - 1;
      if (mode === 'ddz') { g.ddzMultiplier = 4; g.players[0].secondGeneral = { id: 88, name: '副将', skills: [] }; }
      if (mode === '1v1') g.players[1].duelFirstDraw = true;
      const snap = JSON.parse(JSON.stringify(g.snapshot()));
      const g2 = new SGS.Game({ mode, seed: 77, humanSeat: 0, agents: [], onUpdate() {} });
      g2.players = Array.from({ length: count }, (_, i) => P({ name: 'X' + i }, i));
      g2.started = true; g2.pause = async () => {};
      try { g2.restore(JSON.parse(JSON.stringify(snap))); } catch (e) { bad.push(mode + ':' + e.message); continue; }
      const ok = g2.mode === mode && g2.players.length === count &&
        g2.turnCount === g.turnCount && g2.currentSeat === g.currentSeat &&
        (mode !== 'ddz' || g2.ddzMultiplier === 4) &&
        (mode !== '1v1' || g2.players[1].duelFirstDraw === true);
      if (!ok) bad.push(mode);
      details.push(mode + '=' + g2.players.length + '人/回合' + g2.turnCount);
    }
    t('T256', '六模式快照/恢复', bad.length === 0, '异常=' + (bad.join(',') || '无') + '；' + details.join('，'));
  }

  // T257 1.0.6 存档（无 rngState）兼容读取
  {
    const g = game([{ name: '甲', role: 'lord', hp: 4 }, { name: '乙', role: 'rebel', hp: 4 }], { mode: '1v1' });
    g.turnCount = 4; g.currentSeat = 1;
    const snap = JSON.parse(JSON.stringify(g.snapshot()));
    delete snap.rngState; // 1.0.6 的 snapshot 没有这个字段
    const g2 = game([{ name: 'x' }, { name: 'y' }], { mode: '1v1' });
    let err = null;
    try { g2.restore(snap); } catch (e) { err = e; }
    t('T257', '1.0.6 无 rngState 存档兼容', !err && g2.turnCount === 4 && g2.currentSeat === 1 && g2.players.length === 2,
      err ? ('异常：' + err.message) : ('回合=' + g2.turnCount + ' 座位=' + g2.currentSeat + ' 人数=' + g2.players.length));
  }

  // T258 非法快照在引擎层拒绝
  {
    const g = game([{ name: '甲' }, { name: '乙' }], { mode: '1v1' });
    let e1 = null, e2 = null;
    try { g.restore(null); } catch (e) { e1 = e; }
    try { g.restore({ mode: '1v1' }); } catch (e) { e2 = e; }
    t('T258', '非法快照拒绝', !!e1 && !!e2, 'null=' + (e1 && e1.message) + '，缺 players=' + (e2 && e2.message));
  }

  // T259 每个回合开始都写快照（含 AI 回合）
  {
    const seats = [];
    const g = new SGS.Game({ mode: '8p', seed: 5, humanSeat: 0, agents: [], onUpdate() {}, onSnapshot: function () { seats.push(this.currentSeat); } });
    g.players = [P({ name: '甲' }, 0), P({ name: '乙' }, 1)];
    g.started = true; g.pause = async () => {};
    g.takeTurn = async function () { this.turnCount += 1; if (this.turnCount >= 3) this.over = true; };
    await g.runLoop();
    t('T259', '每回合开始写快照（含 AI）', seats.length >= 3 && seats.indexOf(0) >= 0 && seats.indexOf(1) >= 0,
      '快照座位序列=' + JSON.stringify(seats));
  }

  // T260 单档大小（8 人局典型快照，字节）——只记录、不设硬阈值
  {
    const g = game([
      { name: '甲', role: 'lord' }, { name: '乙' }, { name: '丙' }, { name: '丁' },
      { name: '戊' }, { name: '己' }, { name: '庚' }, { name: '辛' },
    ], { mode: '8p' });
    g.players.forEach((p, i) => { p.hand = [C('sha', 'spade', 3 + i), C('shan', 'heart', 2), C('tao', 'diamond', 3), C('wuzhong', 'club', 4)]; });
    g.deck = Array.from({ length: 40 }, (_, i) => C('sha', 'spade', (i % 13) + 1));
    const json = JSON.stringify(g.snapshot());
    const bytes = Buffer.byteLength(json, 'utf8');
    t('T260', '8 人局快照大小记录', bytes > 0 && bytes < 512 * 1024, '单档=' + bytes + ' 字节（' + (bytes / 1024).toFixed(1) + ' KB）');
  }

  // T261 AI 视野 Proxy 回归（每个模式少量；完整 50 局用 node tools/ai_vision_check.js）
  {
    let vr = null, err = null;
    try {
      const vision = require(path.join(__dirname, 'ai_vision_check.js'));
      vr = await vision.runVisionAudit({ games: 2, modes: ['8p', '5p', '3v3', 'ddz', '1v1'] });
    } catch (e) { err = e; }
    t('T261', 'AI 视野 Proxy 回归', !err && vr && vr.violations.length === 0 && vr.errors.length === 0,
      err ? ('异常：' + err.message) : ('games=' + vr.games + ' 违规=' + vr.violations.length + ' 错误=' + vr.errors.length));
  }

  // T262 公开行为推断：连续两次对主公出杀，忠臣视角 enemy / 反贼视角 friend
  {
    const g = game([
      { name: '观察忠', role: 'loyalist', hp: 4 },
      { name: '行为人', role: 'rebel', hp: 4 },
      { name: '主公', role: 'lord', hp: 4 },
      { name: '观察反', role: 'rebel', hp: 4 },
    ], { mode: '8p' });
    g.lordSeat = 2;
    g.recent = [
      { kind: 'use', seat: 1, card: 'sha', targets: [2] },
      { kind: 'use', seat: 1, card: 'sha', targets: [2] },
    ];
    const loyal = new SGS.AI(g, 0, { speed: 0 });
    const rebel = new SGS.AI(g, 3, { speed: 0 });
    loyal.scanPublicEvents(); rebel.scanPublicEvents();
    const lr = loyal.relation(g.players[1]);
    const rr = rebel.relation(g.players[1]);
    t('T262', '公开行为推断：攻主公→忠敌反友', lr === 'enemy' && rr === 'friend',
      '忠臣视角=' + lr + '，反贼视角=' + rr + '（行为人真实身份=' + g.players[1].role + '，未被读取）');
  }

  // T263 公开行为推断：援助主公 / 救主公 → 忠臣视角 friend、反贼视角 enemy
  {
    const g = game([
      { name: '观察忠', role: 'loyalist', hp: 4 },
      { name: '行为人', role: 'rebel', hp: 4 },
      { name: '主公', role: 'lord', hp: 4 },
      { name: '观察反', role: 'rebel', hp: 4 },
    ], { mode: '8p' });
    g.lordSeat = 2;
    g.recent = [
      { kind: 'use', seat: 1, card: 'tao', targets: [2] },
      { kind: 'use', seat: 1, card: 'tao', targets: [2] },
    ];
    const loyal = new SGS.AI(g, 0, { speed: 0 });
    const rebel = new SGS.AI(g, 3, { speed: 0 });
    loyal.scanPublicEvents(); rebel.scanPublicEvents();
    const lr = loyal.relation(g.players[1]);
    const rr = rebel.relation(g.players[1]);
    const g2 = game([
      { name: '观察忠2', role: 'loyalist', hp: 4 },
      { name: '救人者', role: 'rebel', hp: 4 },
      { name: '主公2', role: 'lord', hp: 4 },
      { name: '观察反2', role: 'rebel', hp: 4 },
    ], { mode: '8p' });
    g2.lordSeat = 2;
    g2.recent = [{ kind: 'rescue', seat: 1, dyingSeat: 2, phase: 'save' }];
    const l2 = new SGS.AI(g2, 0, { speed: 0 }); l2.scanPublicEvents();
    t('T263', '公开行为推断：援助/救主→忠友反敌', lr === 'friend' && rr === 'enemy' && l2.relation(g2.players[1]) === 'friend',
      '桃援助：忠=' + lr + '/反=' + rr + '；救主：忠=' + l2.relation(g2.players[1]));
  }

  // T264 AI 打牌逻辑：不伤友、不帮敌、不救敌、无懈方向、空城/帷幕、结束出牌
  {
    const g = game([
      { name: 'AI', role: 'loyalist', hp: 4, skills: [] },
      { name: '友', role: 'loyalist', hp: 2, skills: [] },
      { name: '敌', role: 'rebel', hp: 2, skills: [] },
      { name: '主', role: 'lord', hp: 3, skills: [] },
    ], { mode: '8p' });
    g.lordSeat = 3;
    g.players[1].revealed = true;
    g.players[2].revealed = true;
    const ai = new SGS.AI(g, 0, { speed: 0 });
    const friend = g.players[1], enemy = g.players[2], lord = g.players[3];
    const sha = C('sha', 'spade', 7);
    g.players[0].hand = [sha, C('tao', 'heart', 2), C('wuxie', 'spade', 3)];
    const ctx = { card: sha, color: 'black', nature: 'normal', a: {} };
    const vf = ai.targetValue(friend, 'sha', ctx);
    const ve = ai.targetValue(enemy, 'sha', ctx);
    const killTargets = (() => {
      g.players[0].hand = [C('sha', 'spade', 7)];
      return ai.chooseTargets({ type: 'chooseTargets', player: g.players[0], candidates: [0, 1, 2], min: 1, max: 1, reason: '杀的目标' });
    })();
    const healTargets = ai.chooseTargets({ type: 'chooseTargets', player: g.players[0], candidates: [0, 1, 2], min: 1, max: 1, reason: '回复' });
    g.players[0].hand = [C('tao', 'heart', 2), C('tao', 'diamond', 2), C('wuxie', 'spade', 3)];
    const taoId = g.players[0].hand[0].id;
    const saveEnemy = ai.choosePeachResponse({ dyingSeat: 2, options: [{ cardId: taoId }] });
    const saveLord = ai.choosePeachResponse({ dyingSeat: 3, options: [{ cardId: taoId }] });
    const saveFriend = ai.choosePeachResponse({ dyingSeat: 1, options: [{ cardId: taoId }] });
    const wuxieId = g.players[0].hand[2].id;
    const wxFriend = ai.chooseWuxie({ card: { name: 'juedou' }, targetSeat: 1, negated: false, options: [{ cardId: wuxieId }] });
    const wxEnemy = ai.chooseWuxie({ card: { name: 'juedou' }, targetSeat: 2, negated: false, options: [{ cardId: wuxieId }] });
    const wxEnemyCounter = ai.chooseWuxie({ card: { name: 'juedou' }, targetSeat: 2, negated: true, options: [{ cardId: wuxieId }] });
    // 空城：诸葛亮空手时【杀】不再指定
    g.players[2].skills = ['kongcheng']; g.players[2].hand = [];
    const vKong = ai.targetValue(g.players[2], 'sha', ctx);
    // 帷幕：黑锦囊 AOE 对贾诩无效
    g.players[2].skills = ['weimu'];
    const weimuImmune = ai.aoeImmune(g.players[2], 'nanman', 'black');
    const emptyPlay = await ai.choosePlay({ type: 'play', player: g.players[0], actions: [] });
    const ok = vf <= 0 && ve > vf && killTargets.length === 1 && killTargets[0] === 2 &&
      healTargets.length === 1 && healTargets[0] !== 2 &&
      saveEnemy === null && !!saveLord && !!saveFriend &&
      !!wxFriend && wxEnemy === null && !!wxEnemyCounter &&
      vKong === -100 && weimuImmune === true && emptyPlay && emptyPlay.kind === 'end';
    t('T264', 'AI 不伤友/不帮敌/救主/无懈方向/空城帷幕/结束', ok,
      '杀目标=' + JSON.stringify(killTargets) + ' 回复目标=' + JSON.stringify(healTargets) +
      ' 救敌=' + (saveEnemy === null ? '拒绝' : '救') + ' 救主=' + (!!saveLord) + ' 救友=' + (!!saveFriend) +
      ' 无懈友=' + (!!wxFriend) + ' 无懈敌=' + (!!wxEnemy) + ' 反无懈=' + (!!wxEnemyCounter) +
      ' 空城=' + vKong + ' 帷幕=' + weimuImmune + ' 空动作=' + (emptyPlay && emptyPlay.kind));
  }

  // T265 推断随行为调整 + 内奸均势目标
  {
    const g = game([
      { name: '观察忠', role: 'loyalist', hp: 4 },
      { name: '行为人', role: 'rebel', hp: 4 },
      { name: '主公', role: 'lord', hp: 4 },
      { name: '观察反', role: 'rebel', hp: 4 },
    ], { mode: '8p' });
    g.lordSeat = 2;
    g.recent = [
      { kind: 'use', seat: 1, card: 'sha', targets: [2] },
      { kind: 'use', seat: 1, card: 'sha', targets: [2] },
      { kind: 'rescue', seat: 1, dyingSeat: 2, phase: 'save' },
      { kind: 'rescue', seat: 1, dyingSeat: 2, phase: 'save' },
      { kind: 'rescue', seat: 1, dyingSeat: 2, phase: 'save' },
    ];
    const loyal = new SGS.AI(g, 0, { speed: 0 });
    loyal.scanPublicEvents();
    const adjusted = loyal.relation(g.players[1]);
    // 内奸：反贼仍在时保主公，反贼清空后与主公为敌
    const rg = game([
      { name: '内奸', role: 'renegade', hp: 4 },
      { name: '反贼', role: 'rebel', hp: 4 },
      { name: '主公', role: 'lord', hp: 4 },
    ], { mode: '5p' });
    rg.lordSeat = 2;
    rg.players[1].revealed = true; // 反贼身份已公开，内奸才能按均势判断
    const renegade = new SGS.AI(rg, 0, { speed: 0 });
    const lordFriend = renegade.relation(rg.players[2]);
    rg.players[1].alive = false;
    const lordEnemy = renegade.relation(rg.players[2]);
    t('T265', '推断随行为调整 / 内奸均势', adjusted === 'friend' && lordFriend === 'friend' && lordEnemy === 'enemy',
      '攻击2次+救主3次后忠臣视角=' + adjusted + '；内奸：反贼存活时对主公=' + lordFriend + '，反贼清空后=' + lordEnemy);
  }

  // T266 无懈询问不按手牌预先跳过（避免“谁没被问/谁停顿”泄露有无无懈）
  {
    const g = game([{ name: '甲', skills: [] }, { name: '乙', skills: [] }, { name: '丙', skills: [] }]);
    g.handler = async () => null;
    const vc = { id: -70, name: 'guohe', type: 'trick', suit: 'spade', color: 'black', cards: [] };
    await g.isNullified(vc, g.players[0], g.players[1]);
    const asks = g._asks.filter((r) => r && r.need === 'wuxie');
    const seats = Array.from(new Set(asks.map((r) => r.player && r.player.seat))).sort();
    t('T266', '无懈对所有 AI 走询问', seats.length === 3 && asks.every((r) => Array.isArray(r.options)),
      '询问座位=' + JSON.stringify(seats) + '，询问次数=' + asks.length + '（三人均无无懈仍应各问一次）');
  }

  // 汇总（SKIP 不计入失败，单独统计）
  const pass = results.filter((r) => r.pass).length;
  const fails = results.filter((r) => !r.pass);
  const total = results.length + skips.length;
  console.log('\nSUMMARY pass=' + pass + ' fail=' + fails.length + ' skip=' + skips.length + ' total=' + total);
  console.log('FAILED: ' + fails.map((r) => r.id).join(','));
  if (skips.length) console.log('SKIPPED: ' + skips.map((r) => r.id + '(' + r.detail + ')').join(','));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e && e.stack || e); process.exit(2); });
