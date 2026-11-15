/* 三国杀 · 单机版 — 静态数据
 * 牌堆：标准 108 张 + 军争 52 张 = 160 张（依据 QSanguosha 定义）
 * 武将：标准 25 + 神话再临·风/火/林/山 各 8 = 57 名
 * 技能文案：抽取自客户端 cha_spell 官方文本
 */
(function (global) {
  'use strict';

  const SUITS = {
    spade: { cn: '♠', name: '黑桃', color: 'black' },
    heart: { cn: '♥', name: '红桃', color: 'red' },
    club: { cn: '♣', name: '梅花', color: 'black' },
    diamond: { cn: '♦', name: '方块', color: 'red' },
  };
  const RANK_CN = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };

  // ---------------- 牌名定义 ----------------
  const CARDS = {
    // 基本牌
    sha: { name: '杀', pinyin: 'sha', type: 'basic', desc: '出牌阶段，对你攻击范围内的一名其他角色使用。对其造成 1 点伤害。' },
    huosha: { name: '火杀', pinyin: 'huosha', type: 'basic', nature: 'fire', desc: '火属性的【杀】。造成火焰伤害。' },
    leisha: { name: '雷杀', pinyin: 'leisha', type: 'basic', nature: 'thunder', desc: '雷属性的【杀】。造成雷电伤害。' },
    shan: { name: '闪', pinyin: 'shan', type: 'basic', desc: '当你成为【杀】的目标时，对此【杀】使用。抵消此【杀】。' },
    tao: { name: '桃', pinyin: 'tao', type: 'basic', desc: '出牌阶段，对已受伤的你使用，回复 1 点体力；或于一名角色濒死时对其使用。' },
    jiu: { name: '酒', pinyin: 'jiu', type: 'basic', desc: '出牌阶段，对你使用：本回合你使用的下一张【杀】伤害 +1。当你处于濒死状态时，可以对你使用，回复 1 点体力。' },

    // 锦囊
    juedou: { name: '决斗', pinyin: 'juedou', type: 'trick', desc: '对一名其他角色使用。由其开始轮流打出【杀】，首先不出者受到另一方 1 点伤害。' },
    guohe: { name: '过河拆桥', pinyin: 'guohe', type: 'trick', desc: '对一名区域里有牌的其他角色使用。弃置其区域里的一张牌。' },
    shunshou: { name: '顺手牵羊', pinyin: 'shunshou', type: 'trick', desc: '对距离为 1 的一名区域里有牌的其他角色使用。获得其区域里的一张牌。' },
    wuzhong: { name: '无中生有', pinyin: 'wuzhong', type: 'trick', desc: '对你使用。摸两张牌。' },
    jiedao: { name: '借刀杀人', pinyin: 'jiedao', type: 'trick', desc: '对装备区里有武器牌的一名其他角色使用。令其对你指定的另一名角色使用【杀】，否则将武器交给你。' },
    nanman: { name: '南蛮入侵', pinyin: 'nanman', type: 'trick', desc: '对所有其他角色使用。每名目标需打出一张【杀】，否则受到 1 点伤害。' },
    wanjian: { name: '万箭齐发', pinyin: 'wanjian', type: 'trick', desc: '对所有其他角色使用。每名目标需打出一张【闪】，否则受到 1 点伤害。' },
    taoyuan: { name: '桃园结义', pinyin: 'taoyuan', type: 'trick', desc: '对所有角色使用。每名目标回复 1 点体力。' },
    wugu: { name: '五谷丰登', pinyin: 'wugu', type: 'trick', desc: '对所有角色使用。亮出等于目标数的牌，每名目标依次获得其中一张。' },
    wuxie: { name: '无懈可击', pinyin: 'wuxie', type: 'trick', desc: '当一张锦囊牌生效前，对此牌使用。抵消此牌对一名目标角色的效果。' },
    huogong: { name: '火攻', pinyin: 'huogong', type: 'trick', desc: '对一名有手牌的角色使用。其展示一张手牌，然后你可以弃置一张与之花色相同的手牌，对其造成 1 点火焰伤害。' },
    tiesuo: { name: '铁索连环', pinyin: 'tiesuo', type: 'trick', recast: true, desc: '选择一至两名角色，横置或重置其武将牌。重铸：出牌阶段弃置此牌，摸一张牌。' },

    // 延时锦囊
    lebu: { name: '乐不思蜀', pinyin: 'lebu', type: 'delayed', desc: '横置于目标判定区。其判定阶段判定：若不为红桃，跳过出牌阶段。' },
    shandian: { name: '闪电', pinyin: 'shandian', type: 'delayed', desc: '横置于你的判定区。判定：若为黑桃 2~9，你受到 3 点雷电伤害；否则移到下家判定区。' },
    bingliang: { name: '兵粮寸断', pinyin: 'bingliang', type: 'delayed', desc: '对距离 1 内的一名其他角色使用。其判定阶段判定：若不为梅花，跳过摸牌阶段。' },

    // 装备
    zhugeliannu: { name: '诸葛连弩', pinyin: 'zhugeliannu', type: 'equip', subtype: 'weapon', range: 1, desc: '攻击范围 1。你使用【杀】无次数限制。' },
    qinggang: { name: '青釭剑', pinyin: 'qinggang', type: 'equip', subtype: 'weapon', range: 2, desc: '攻击范围 2。你使用【杀】时无视目标防具。' },
    cixiong: { name: '雌雄双股剑', pinyin: 'cixiong', type: 'equip', subtype: 'weapon', range: 2, desc: '攻击范围 2。使用【杀】指定异性目标后，可令其弃一张手牌，或你摸一张牌。' },
    qinglong: { name: '青龙偃月刀', pinyin: 'qinglong', type: 'equip', subtype: 'weapon', range: 3, desc: '攻击范围 3。【杀】被【闪】抵消后，可对同一目标再使用一张【杀】。' },
    zhangba: { name: '丈八蛇矛', pinyin: 'zhangba', type: 'equip', subtype: 'weapon', range: 3, desc: '攻击范围 3。你可以将两张手牌当【杀】使用或打出。' },
    guanshi: { name: '贯石斧', pinyin: 'guanshi', type: 'equip', subtype: 'weapon', range: 3, desc: '攻击范围 3。【杀】被【闪】抵消后，可弃两张牌令此【杀】依然造成伤害。' },
    fangtian: { name: '方天画戟', pinyin: 'fangtian', type: 'equip', subtype: 'weapon', range: 4, desc: '攻击范围 4。若此【杀】为你最后的手牌，你可以额外选择至多两个目标。' },
    qilin: { name: '麒麟弓', pinyin: 'qilin', type: 'equip', subtype: 'weapon', range: 5, desc: '攻击范围 5。【杀】造成伤害时，可弃置目标一张坐骑牌。' },
    hanbing: { name: '寒冰剑', pinyin: 'hanbing', type: 'equip', subtype: 'weapon', range: 2, desc: '攻击范围 2。【杀】造成伤害时，可防止伤害，改为弃置目标两张牌。' },
    gudingdao: { name: '古锭刀', pinyin: 'gudingdao', type: 'equip', subtype: 'weapon', range: 2, desc: '攻击范围 2。锁定技，你使用【杀】造成伤害时，若目标没有手牌，此伤害 +1。' },
    zhuque: { name: '朱雀羽扇', pinyin: 'zhuque', type: 'equip', subtype: 'weapon', range: 4, desc: '攻击范围 4。你可以将一张普通【杀】当火【杀】使用。' },
    bagua: { name: '八卦阵', pinyin: 'bagua', type: 'equip', subtype: 'armor', desc: '需要【闪】时可判定：若为红色，视为使用了一张【闪】。' },
    renwang: { name: '仁王盾', pinyin: 'renwang', type: 'equip', subtype: 'armor', desc: '锁定技，黑色【杀】对你无效。' },
    tengjia: { name: '藤甲', pinyin: 'tengjia', type: 'equip', subtype: 'armor', desc: '锁定技，【南蛮入侵】【万箭齐发】和普通【杀】对你无效；你受到火焰伤害时，此伤害 +1。' },
    baiyinshizi: { name: '白银狮子', pinyin: 'baiyinshizi', type: 'equip', subtype: 'armor', desc: '锁定技，你受到的伤害至多为 1 点；当你失去此牌时，回复 1 点体力。' },
    chitu: { name: '赤兔', pinyin: 'chitu', type: 'equip', subtype: 'offhorse', desc: '-1 坐骑。你计算与其他角色的距离 -1。' },
    dawan: { name: '大宛', pinyin: 'dawan', type: 'equip', subtype: 'offhorse', desc: '-1 坐骑。你计算与其他角色的距离 -1。' },
    zixing: { name: '紫骍', pinyin: 'zixing', type: 'equip', subtype: 'offhorse', desc: '-1 坐骑。你计算与其他角色的距离 -1。' },
    dilu: { name: '的卢', pinyin: 'dilu', type: 'equip', subtype: 'defhorse', desc: '+1 坐骑。其他角色计算与你的距离 +1。' },
    jueying: { name: '绝影', pinyin: 'jueying', type: 'equip', subtype: 'defhorse', desc: '+1 坐骑。其他角色计算与你的距离 +1。' },
    zhuahuang: { name: '爪黄飞电', pinyin: 'zhuahuang', type: 'equip', subtype: 'defhorse', desc: '+1 坐骑。其他角色计算与你的距离 +1。' },
    hualiu: { name: '骅骝', pinyin: 'hualiu', type: 'equip', subtype: 'defhorse', desc: '+1 坐骑。其他角色计算与你的距离 +1。' },
  };

  // ---------------- 牌堆 ----------------
  const DECK_STANDARD = [
    ['sha', 'spade', 7], ['sha', 'spade', 8], ['sha', 'spade', 8], ['sha', 'spade', 9], ['sha', 'spade', 9], ['sha', 'spade', 10], ['sha', 'spade', 10],
    ['sha', 'club', 2], ['sha', 'club', 3], ['sha', 'club', 4], ['sha', 'club', 5], ['sha', 'club', 6], ['sha', 'club', 7],
    ['sha', 'club', 8], ['sha', 'club', 8], ['sha', 'club', 9], ['sha', 'club', 9], ['sha', 'club', 10], ['sha', 'club', 10], ['sha', 'club', 11], ['sha', 'club', 11],
    ['sha', 'heart', 10], ['sha', 'heart', 10], ['sha', 'heart', 11],
    ['sha', 'diamond', 6], ['sha', 'diamond', 7], ['sha', 'diamond', 8], ['sha', 'diamond', 9], ['sha', 'diamond', 10], ['sha', 'diamond', 13],
    ['shan', 'heart', 2], ['shan', 'heart', 2], ['shan', 'heart', 13],
    ['shan', 'diamond', 2], ['shan', 'diamond', 2], ['shan', 'diamond', 3], ['shan', 'diamond', 4], ['shan', 'diamond', 5],
    ['shan', 'diamond', 6], ['shan', 'diamond', 7], ['shan', 'diamond', 8], ['shan', 'diamond', 9], ['shan', 'diamond', 10], ['shan', 'diamond', 11], ['shan', 'diamond', 11],
    ['tao', 'heart', 3], ['tao', 'heart', 4], ['tao', 'heart', 6], ['tao', 'heart', 7], ['tao', 'heart', 8], ['tao', 'heart', 9], ['tao', 'heart', 12],
    ['tao', 'diamond', 12],
    ['zhugeliannu', 'club', 1], ['zhugeliannu', 'diamond', 1],
    ['cixiong', 'spade', 2], ['qinggang', 'spade', 6], ['qinglong', 'spade', 5], ['zhangba', 'spade', 12],
    ['guanshi', 'diamond', 5], ['fangtian', 'diamond', 12], ['qilin', 'heart', 5],
    ['bagua', 'spade', 2], ['bagua', 'club', 2], ['renwang', 'club', 2],
    ['jueying', 'spade', 5], ['dilu', 'club', 5], ['zhuahuang', 'heart', 13],
    ['chitu', 'heart', 5], ['dawan', 'spade', 13], ['zixing', 'diamond', 13],
    ['wugu', 'heart', 3], ['wugu', 'heart', 4],
    ['taoyuan', 'heart', 1],
    ['nanman', 'spade', 7], ['nanman', 'spade', 13], ['nanman', 'club', 7],
    ['wanjian', 'heart', 1],
    ['juedou', 'spade', 1], ['juedou', 'club', 1], ['juedou', 'diamond', 1],
    ['wuzhong', 'heart', 7], ['wuzhong', 'heart', 8], ['wuzhong', 'heart', 9], ['wuzhong', 'heart', 11],
    ['shunshou', 'spade', 3], ['shunshou', 'spade', 4], ['shunshou', 'spade', 11], ['shunshou', 'diamond', 3], ['shunshou', 'diamond', 4],
    ['guohe', 'spade', 3], ['guohe', 'spade', 4], ['guohe', 'spade', 12], ['guohe', 'club', 3], ['guohe', 'club', 4], ['guohe', 'heart', 12],
    ['jiedao', 'club', 12], ['jiedao', 'club', 13],
    ['wuxie', 'spade', 11], ['wuxie', 'club', 12], ['wuxie', 'club', 13], ['wuxie', 'diamond', 12],
    ['lebu', 'spade', 6], ['lebu', 'club', 6], ['lebu', 'heart', 6],
    ['shandian', 'spade', 1], ['shandian', 'heart', 12],
    ['hanbing', 'spade', 2],
  ];

  const DECK_MANEUVERING = [
    // 黑桃 13
    ['gudingdao', 'spade', 1], ['tengjia', 'spade', 2], ['jiu', 'spade', 3],
    ['leisha', 'spade', 4], ['leisha', 'spade', 5], ['leisha', 'spade', 6], ['leisha', 'spade', 7], ['leisha', 'spade', 8],
    ['jiu', 'spade', 9], ['bingliang', 'spade', 10], ['tiesuo', 'spade', 11], ['tiesuo', 'spade', 12], ['wuxie', 'spade', 13],
    // 梅花 13
    ['baiyinshizi', 'club', 1], ['tengjia', 'club', 2], ['jiu', 'club', 3], ['bingliang', 'club', 4],
    ['leisha', 'club', 5], ['leisha', 'club', 6], ['leisha', 'club', 7], ['leisha', 'club', 8],
    ['jiu', 'club', 9], ['tiesuo', 'club', 10], ['tiesuo', 'club', 11], ['tiesuo', 'club', 12], ['tiesuo', 'club', 13],
    // 红桃 13
    ['wuxie', 'heart', 1], ['huogong', 'heart', 2], ['huogong', 'heart', 3],
    ['huosha', 'heart', 4], ['tao', 'heart', 5], ['tao', 'heart', 6], ['huosha', 'heart', 7],
    ['shan', 'heart', 8], ['shan', 'heart', 9], ['huosha', 'heart', 10], ['shan', 'heart', 11], ['shan', 'heart', 12], ['wuxie', 'heart', 13],
    // 方块 13
    ['zhuque', 'diamond', 1], ['tao', 'diamond', 2], ['tao', 'diamond', 3],
    ['huosha', 'diamond', 4], ['huosha', 'diamond', 5], ['shan', 'diamond', 6], ['shan', 'diamond', 7], ['shan', 'diamond', 8],
    ['jiu', 'diamond', 9], ['shan', 'diamond', 10], ['shan', 'diamond', 11], ['huogong', 'diamond', 12], ['hualiu', 'diamond', 13],
  ];

  // 斗地主专属牌（list6 id 6100-6104；6105「聚众」是农民技能，不是牌）
  // 类型依据 cha_spell.GameSpells.spell[].i：0基本/1锦囊/2技能/3武器/4防具
  // 花色点数依据 list5 RuleId 71 PlayCardPile 的实例（1♥2♦3♠4♣）
  const CARDS_DDZ = {
    jiwangkailai: { noArt: true, name: '继往开来', pinyin: 'jiwangkailai', type: 'trick', ddz: true, desc: '出牌阶段，选择一项：1.对自己使用，弃置所有手牌，然后摸等量张牌；2.将所有手牌当一张普通锦囊牌使用（【炸弹】【继往开来】【进退自如】【攻守兼备】除外）。' },
    gongshoujianbei: { noArt: true, name: '攻守兼备', pinyin: 'gongshoujianbei', type: 'trick', ddz: true, desc: '出牌阶段，选择一项：1.当【万箭齐发】，对所有其他角色使用，每人需打出一张【闪】，否则受到1点伤害；2.当【桃园结义】，对所有角色使用，每名角色回复1点体力。' },
    jintuiziru: { noArt: true, name: '进退自如', pinyin: 'jintuiziru', type: 'trick', ddz: true, desc: '出牌阶段，选择一项：1.当【南蛮入侵】，对所有其他角色使用，每人需打出一张【杀】，否则受到1点伤害；2.当【五谷丰登】，对所有角色使用，从专属牌堆顶亮出三张牌，每人获得其中一张。' },
    zhadan: { noArt: true, name: '炸弹', pinyin: 'zhadan', type: 'trick', ddz: true, responseOnly: true, desc: '（炸弹激活后）当敌方角色一张牌生效前，抵消此牌的效果且不能被【无懈可击】响应，然后本局游戏的底价改为当前底价加倍（不能超过加倍上限）。' },
    diqi: { noArt: true, name: '地契', pinyin: 'diqi', type: 'equip', subtype: 'armor', ddz: true, desc: '游戏开始时，将此牌放入地主的防具栏。当你受到伤害时，你可以弃置此牌防止伤害。当此牌离开你的防具栏时，你销毁此牌。' },
  };
  // 专用牌不进入 CARDS 的枚举（无卡图，避免被通用素材/图鉴校验当作普通牌）；
  // 引擎通过 CARDS[name] 直接查表仍然可用。
  for (const k of Object.keys(CARDS_DDZ)) Object.defineProperty(CARDS, k, { value: CARDS_DDZ[k], enumerable: false, configurable: true, writable: true });

  // 斗地主专属牌堆：108 张（list5 RuleId 71 PlayCardPile 的 108 个实例逐张反查）
  const DECK_DDZ = [
    ['gudingdao','spade',1], ['tengjia','spade',2], ['jiu','spade',3], ['sha','spade',4],
    ['sha','spade',5], ['sha','spade',6], ['sha','spade',7], ['sha','spade',8],
    ['jiu','spade',9], ['gongshoujianbei','spade',10], ['tiesuo','spade',11], ['tiesuo','spade',12],
    ['wuxie','spade',13], ['baiyinshizi','club',1], ['tengjia','club',2], ['jiu','club',3],
    ['jintuiziru','club',4], ['sha','club',5], ['sha','club',6], ['sha','club',7],
    ['sha','club',8], ['jiu','club',9], ['tiesuo','club',10], ['tiesuo','club',11],
    ['tiesuo','club',12], ['tiesuo','club',13], ['wuxie','heart',1], ['huogong','heart',2],
    ['huogong','heart',3], ['sha','heart',4], ['tao','heart',5], ['tao','heart',6],
    ['sha','heart',7], ['shan','heart',8], ['shan','heart',9], ['sha','heart',10],
    ['shan','heart',11], ['shan','heart',12], ['wuxie','heart',13], ['zhuque','diamond',1],
    ['tao','diamond',2], ['tao','diamond',3], ['sha','diamond',4], ['sha','diamond',5],
    ['shan','diamond',6], ['shan','diamond',7], ['shan','diamond',8], ['jiu','diamond',9],
    ['shan','diamond',10], ['shan','diamond',11], ['huogong','diamond',12], ['hualiu','diamond',13],
    ['zhadan','spade',1], ['cixiong','spade',2], ['guohe','spade',3], ['guohe','spade',4],
    ['qinglong','spade',5], ['jiwangkailai','spade',6], ['jintuiziru','spade',7], ['sha','spade',8],
    ['sha','spade',9], ['sha','spade',10], ['shunshou','spade',11], ['zhangba','spade',12],
    ['dawan','spade',13], ['zhugeliannu','club',1], ['bagua','club',2], ['sha','club',3],
    ['sha','club',4], ['dilu','club',5], ['sha','club',6], ['sha','club',7],
    ['sha','club',8], ['sha','club',9], ['sha','club',10], ['sha','club',11],
    ['wuxie','club',12], ['jiedao','club',13], ['gongshoujianbei','heart',1], ['shan','heart',2],
    ['wuzhong','heart',3], ['tao','heart',4], ['chitu','heart',5], ['jiwangkailai','heart',6],
    ['tao','heart',7], ['wuzhong','heart',8], ['tao','heart',9], ['sha','heart',10],
    ['wuzhong','heart',11], ['guohe','heart',12], ['zhuahuang','heart',13], ['juedou','diamond',1],
    ['shan','diamond',2], ['shan','diamond',3], ['shunshou','diamond',4], ['guanshi','diamond',5],
    ['sha','diamond',6], ['shan','diamond',7], ['shan','diamond',8], ['shan','diamond',9],
    ['sha','diamond',10], ['shan','diamond',11], ['tao','diamond',12], ['sha','diamond',13],
    ['juedou','spade',1], ['wuxie','club',13], ['zhadan','heart',1], ['wuxie','diamond',13],
  ];
  // 斗地主场次（list7 hd_fight_lord_config.Root.Label：基础场/高级场/练兵场）
  // maxMultiple：基础场 2 / 高级场 4 / 练兵场 2；bomb：2/3/2（bomb 与 RuleId71 的 2 张冲突，见 docs 未确认）
  const DDZ_SCENES = {
    basic: { name: '基础场', maxMultiple: 2, bomb: 2 },
    advanced: { name: '高级场', maxMultiple: 4, bomb: 3 },
    practice: { name: '练兵场', maxMultiple: 2, bomb: 2 },
  };
  const DDZ_MAX_MULTIPLE = DDZ_SCENES.advanced.maxMultiple; // 默认场次=高级场（见未确认项）

  // 1v1 面杀：军争牌堆移除 52 张（RuleId 98 PlayCardBan 反查出的牌名张数）
  const DECK_1V1_BAN = {
    sha: 12, shan: 10, tao: 4, wuxie: 3, tiesuo: 3, shunshou: 2, jiu: 2,
    huogong: 1, wugu: 1, wuzhong: 1, zhugeliannu: 1, fangtian: 1, zixing: 1,
    bagua: 1, tengjia: 1, jueying: 1, qinggang: 1, nanman: 1, juedou: 1,
    renwang: 1, guohe: 1, dilu: 1, lebu: 1,
  };

  // ---------------- 57 名武将 ----------------
  const G = (id, name, kingdom, hp, gender, pack, skills, title, lord) => ({ id, name, kingdom, hp, gender, pack, skills, title: title || '', lord: !!lord });
  const GENERALS = [
    // 标准包
    G(1, '刘备', '蜀', 4, 'male', '标准', ['rende', 'jijiang'], '仁德之君', true),
    G(2, '关羽', '蜀', 4, 'male', '标准', ['wusheng'], '美髯公'),
    G(3, '张飞', '蜀', 4, 'male', '标准', ['paoxiao'], '万夫不当'),
    G(4, '诸葛亮', '蜀', 3, 'male', '标准', ['guanxing', 'kongcheng'], '卧龙'),
    G(5, '赵云', '蜀', 4, 'male', '标准', ['longdan'], '虎威将军'),
    G(6, '马超', '蜀', 4, 'male', '标准', ['mashu', 'tieji'], '一骑当千'),
    G(7, '黄月英', '蜀', 3, 'female', '标准', ['jizhi', 'qicai'], '归心之才'),
    G(8, '孙权', '吴', 4, 'male', '标准', ['zhiheng', 'jiuyuan'], '制衡之主', true),
    G(9, '甘宁', '吴', 4, 'male', '标准', ['qixi'], '锦帆游侠'),
    G(10, '吕蒙', '吴', 4, 'male', '标准', ['keji'], '白衣渡江'),
    G(11, '黄盖', '吴', 4, 'male', '标准', ['kurou'], '轻身为国'),
    G(12, '周瑜', '吴', 3, 'male', '标准', ['yingzi', 'fanjian'], '江东美周郎'),
    G(13, '大乔', '吴', 3, 'female', '标准', ['guose', 'liuli'], '国色天香'),
    G(14, '陆逊', '吴', 3, 'male', '标准', ['qianxun', 'lianying'], '儒生雄才'),
    G(15, '曹操', '魏', 4, 'male', '标准', ['jianxiong', 'hujia'], '乱世奸雄', true),
    G(16, '司马懿', '魏', 3, 'male', '标准', ['fankui', 'guicai'], '狼顾之鬼'),
    G(17, '夏侯惇', '魏', 4, 'male', '标准', ['ganglie'], '独眼刚烈'),
    G(18, '张辽', '魏', 4, 'male', '标准', ['tuxi'], '威震逍遥津'),
    G(19, '许褚', '魏', 4, 'male', '标准', ['luoyi'], '虎痴'),
    G(20, '郭嘉', '魏', 3, 'male', '标准', ['tiandu', 'yiji'], '早终的先知'),
    G(21, '甄姬', '魏', 3, 'female', '标准', ['qingguo', 'luoshen'], '洛神'),
    G(22, '华佗', '群', 3, 'male', '标准', ['jijiu', 'qingnang'], '神医'),
    G(23, '吕布', '群', 4, 'male', '标准', ['wushuang'], '武的化身'),
    G(24, '貂蝉', '群', 3, 'female', '标准', ['lijian', 'biyue'], '绝世的舞姬'),
    G(25, '孙尚香', '吴', 3, 'female', '标准', ['jieyin', 'xiaoji'], '弓腰姬'),
    // 风
    G(26, '黄忠', '蜀', 4, 'male', '风', ['liegong'], '老当益壮'),
    G(27, '魏延', '蜀', 4, 'male', '风', ['kuanggu'], '镇北将军'),
    G(28, '夏侯渊', '魏', 4, 'male', '风', ['shensu'], '疾行猎手'),
    G(29, '曹仁', '魏', 4, 'male', '风', ['jushou'], '铁壁将军'),
    G(30, '小乔', '吴', 3, 'female', '风', ['tianxiang', 'hongyan'], '怜香惜玉'),
    G(31, '周泰', '吴', 4, 'male', '风', ['buqu'], '百战之身'),
    G(32, '张角', '群', 3, 'male', '风', ['leiji', 'guidao', 'huangtian'], '天公将军', true),
    G(33, '于吉', '群', 3, 'male', '风', ['guhuo'], '太平道人'),
    // 火
    G(34, '典韦', '魏', 4, 'male', '火', ['qiangxi'], '古之恶来'),
    G(35, '荀彧', '魏', 3, 'male', '火', ['quhu', 'jieming'], '王佐之才'),
    G(36, '庞统', '蜀', 3, 'male', '火', ['lianhuan', 'niepan'], '凤雏'),
    G(37, '卧龙诸葛亮', '蜀', 3, 'male', '火', ['bazhen', 'huoji', 'kanpo'], '卧龙'),
    G(38, '太史慈', '吴', 4, 'male', '火', ['tianyi'], '笃烈之士'),
    G(39, '庞德', '魏', 4, 'male', '火', ['mashu', 'mengjin'], '抬榇之将'),
    G(40, '颜良文丑', '群', 4, 'male', '火', ['shuangxiong'], '双雄'),
    G(41, '袁绍', '群', 4, 'male', '火', ['luanji', 'xueyi'], '四世三公', true),
    // 林
    G(42, '徐晃', '魏', 4, 'male', '林', ['duanliang'], '周亚夫之风'),
    G(43, '曹丕', '魏', 3, 'male', '林', ['xingshang', 'fangzhu', 'songwei'], '霸业的继承者', true),
    G(44, '孙坚', '吴', 4, 'male', '林', ['yinghun'], '江东猛虎'),
    G(45, '董卓', '群', 8, 'male', '林', ['jiuchi', 'rourin', 'bengqiang', 'baonue'], '乱世魔王', true),
    G(46, '祝融', '群', 4, 'female', '林', ['juxiang', 'lieren'], '南蛮女主'),
    G(47, '孟获', '群', 4, 'male', '林', ['huoshou', 'zaiqi'], '南蛮王'),
    G(48, '贾诩', '群', 3, 'male', '林', ['wansha', 'luanwu', 'weimu'], '毒士'),
    G(49, '鲁肃', '吴', 3, 'male', '林', ['haoshi', 'dimeng'], '缔盟之臣'),
    // 山
    G(50, '张郃', '魏', 4, 'male', '山', ['qiaobian'], '巧变之将'),
    G(51, '邓艾', '魏', 4, 'male', '山', ['tuntian', 'zaoxian'], '屯田之将'),
    G(52, '姜维', '蜀', 4, 'male', '山', ['tiaoxin', 'zhiji'], '天水麒麟儿'),
    G(53, '刘禅', '蜀', 3, 'male', '山', ['xiangle', 'fangquan', 'ruoyu'], '无为而治', true),
    G(54, '孙策', '吴', 4, 'male', '山', ['jiang', 'hunzi', 'zhiba'], '江东小霸王', true),
    G(55, '张昭张纮', '吴', 3, 'male', '山', ['zhijian', 'guzheng'], '二张'),
    G(56, '左慈', '群', 3, 'male', '山', ['huashen', 'xinsheng'], '迷之仙人'),
    G(57, '蔡文姬', '群', 3, 'female', '山', ['beige', 'duanchang'], '异乡的孤女'),
  ];

  const KINGDOM_COLOR = { 蜀: '#c0392b', 魏: '#2c5aa0', 吴: '#1e8449', 群: '#7d6b3f', 晋: '#6c4fa1' };

  // ---------------- 变体扩展包（30 名，默认关闭） ----------------
  // 素材：assets/extras/manifest.json（Bundles 原尺寸立绘 big 535x678 / seat 139x214）。
  // 名称/势力按 manifest；性别/体力按原版 list1.sgs（h=1 男/2 女，i=体力，j/k=原版技能 id）。
  // 27 名有基础武将的按 manifest.baseSkills 复用现有技能；304/320/446 无基础武将，
  // 按 list6.sgs 的原版技能单独实现（诛害/潜心/荐言、义从/趫猛、耀武）。
  // 注意：这些武将只在显式启用 extras 扩展包（packs 含 'extras' 或 new Game({extras:true})）时进入将池。
  const PO_VERSION = 'Po（原版变体，未确认中文名）';
  const versionTitle = (v) => (v === '界' ? '界' : v === 'OL/线上版' ? 'OL' : '变体');
  const E = (id, name, kingdom, hp, gender, skills, baseGeneral, version) =>
    Object.assign(G(id, name, kingdom, hp, gender, 'extras', skills, versionTitle(version)), {
      baseGeneral, variant: true, version, versionTitle: versionTitle(version),
    });
  const EXTRA_GENERALS = [
    E(61, '黄忠', '蜀', 4, 'male', ['j_liegong'], 26, '其它'),
    E(108, '赵云', '群', 3, 'male', ['longdan', 'j_chongzhen'], 5, 'OL/线上版'),
    E(299, '刘备', '蜀', 4, 'male', ['j_rende', 'j_jijiang'], 1, '界'),
    E(300, '关羽', '蜀', 4, 'male', ['j_wusheng', 'j_yijue'], 2, PO_VERSION),
    E(301, '张飞', '蜀', 4, 'male', ['j_paoxiao', 'j_tishen'], 3, PO_VERSION),
    E(302, '赵云', '蜀', 4, 'male', ['j_longdan', 'j_yajiao'], 5, PO_VERSION),
    E(303, '马超', '蜀', 4, 'male', ['mashu', 'j_tieji'], 6, PO_VERSION),
    E(304, '徐庶', '蜀', 4, 'male', ['zhuhai', 'qianxin'], null, PO_VERSION),
    E(305, '甘宁', '吴', 4, 'male', ['qixi', 'j_fenwei'], 9, PO_VERSION),
    E(306, '吕蒙', '吴', 4, 'male', ['keji', 'j_qinxue'], 10, PO_VERSION),
    E(307, '黄盖', '吴', 4, 'male', ['j_kurou', 'j_zhaxiang'], 11, PO_VERSION),
    E(308, '周瑜', '吴', 3, 'male', ['j_yingzi', 'j_fanjian'], 12, PO_VERSION),
    E(309, '大乔', '吴', 3, 'female', ['j_guose', 'liuli'], 13, PO_VERSION),
    E(310, '陆逊', '吴', 3, 'male', ['j_qianxun', 'j_lianying'], 14, PO_VERSION),
    E(311, '曹操', '魏', 4, 'male', ['j_jianxiong', 'j_hujia'], 15, PO_VERSION),
    E(312, '司马懿', '魏', 3, 'male', ['j_fankui', 'j_guicai'], 16, PO_VERSION),
    E(313, '夏侯惇', '魏', 4, 'male', ['j_ganglie', 'j_qingjian'], 17, PO_VERSION),
    E(314, '张辽', '魏', 4, 'male', ['j_tuxi'], 18, PO_VERSION),
    E(315, '许褚', '魏', 4, 'male', ['j_luoyi'], 19, PO_VERSION),
    E(316, '郭嘉', '魏', 3, 'male', ['tiandu', 'j_yiji'], 20, PO_VERSION),
    E(318, '华佗', '群', 3, 'male', ['jijiu', 'j_chuli'], 22, PO_VERSION),
    E(319, '吕布', '群', 4, 'male', ['wushuang', 'j_liyu'], 23, PO_VERSION),
    E(320, '公孙瓒', '群', 4, 'male', ['yicong', 'qiaomeng'], null, PO_VERSION),
    E(440, '诸葛亮', '蜀', 3, 'male', ['j_guanxing', 'kongcheng'], 4, PO_VERSION),
    E(441, '黄月英', '蜀', 3, 'female', ['j_jizhi', 'j_qicai'], 7, PO_VERSION),
    E(442, '孙权', '吴', 4, 'male', ['j_zhiheng', 'j_jiuyuan'], 8, '界'),
    E(443, '孙尚香', '吴', 3, 'female', ['j_jieyin', 'xiaoji'], 25, PO_VERSION),
    E(444, '甄姬', '魏', 3, 'female', ['j_luoshen', 'qingguo'], 21, PO_VERSION),
    E(445, '貂蝉', '群', 3, 'female', ['lijian', 'j_biyue'], 24, PO_VERSION),
    E(446, '华雄', '群', 6, 'male', ['j_yaowu', 'shizhan'], null, PO_VERSION),
  ];
  GENERALS.push(...EXTRA_GENERALS);

  // ---------------- New1V1 独立将池（晋） ----------------
  // 来源：list1.sgs 的 New1V1* 条目（a=3044..3051 / gid=7000..7007，g=6 晋）。
  // 独立数组，不并入 GENERALS：普通 8p/5p/1v1(all/classic)/2v2/3v3/ddz/extras 池均不可见；
  // 仅当 new Game({mode:'1v1', duelPool:'new1v1'}) 时使用。
  // 未实现技能不写入 skills（不伪造）：宜室7002、昭然7014、昭讨7019/破竹7020、清冷7022。
  const NEW_DUEL_GENERALS = [
    G(7000, '张虎乐綝', '晋', 4, 'male', 'new1v1', ['j_xijue'], '新1V1'),
    G(7001, '夏侯徽', '晋', 3, 'female', 'new1v1', ['j_shidu'], '新1V1'),
    G(7002, '司马师', '晋', 3, 'male', 'new1v1', ['j_yimie', 'j_tairan'], '新1V1'),
    G(7004, '司马昭', '晋', 3, 'male', 'new1v1', ['j_choufa'], '新1V1'),
    G(7005, '王元姬', '晋', 3, 'female', 'new1v1', ['j_yanxi'], '新1V1'),
    G(7006, '杜预', '晋', 4, 'male', 'new1v1', ['j_sanchen'], '新1V1'),
    G(7007, '张春华', '晋', 3, 'female', 'new1v1', ['j_huishi'], '新1V1'),
  ];
  NEW_DUEL_GENERALS.forEach((g) => { g.newDuel = true; g.gradation = 0; });
  // New1V1 原版 50 人中项目可用的 39 名基础将（技能仍为基础版，明确近似）
  const NEW_DUEL_BASE_NAMES = [
    '曹操',
    '司马懿',
    '夏侯惇',
    '张辽',
    '许褚',
    '郭嘉',
    '甄姬',
    '夏侯渊',
    '徐晃',
    '曹仁',
    '典韦',
    '刘备',
    '关羽',
    '张飞',
    '诸葛亮',
    '赵云',
    '马超',
    '黄月英',
    '黄忠',
    '魏延',
    '姜维',
    '孟获',
    '祝融',
    '孙权',
    '甘宁',
    '吕蒙',
    '黄盖',
    '周瑜',
    '大乔',
    '陆逊',
    '孙尚香',
    '孙坚',
    '小乔',
    '周泰',
    '华佗',
    '吕布',
    '貂蝉',
    '庞德',
    '张角',
  ];
  const NEW_DUEL_PACK = { id: 'new1v1', name: '新1V1将池', defaultEnabled: false, generals: NEW_DUEL_GENERALS };

  // ---------------- 技能元数据 ----------------
  const S = (name, extra) => Object.assign({ name }, extra || {});
  const SKILLS = {
    // 标准
    rende: S('仁德'), jijiang: S('激将', { lord: true }), wusheng: S('武圣'), paoxiao: S('咆哮', { locked: true }),
    guanxing: S('观星'), kongcheng: S('空城', { locked: true }), longdan: S('龙胆'), mashu: S('马术', { locked: true }),
    tieji: S('铁骑'), jizhi: S('集智'), qicai: S('奇才', { locked: true }), zhiheng: S('制衡', { active: true }),
    jiuyuan: S('救援', { lord: true, locked: true }), qixi: S('奇袭'), keji: S('克己'), kurou: S('苦肉', { active: true }),
    yingzi: S('英姿'), fanjian: S('反间', { active: true }), guose: S('国色'), liuli: S('流离'), qianxun: S('谦逊', { locked: true }),
    lianying: S('连营'), jieyin: S('结姻', { active: true }), xiaoji: S('枭姬'), jijiu: S('急救'), qingnang: S('青囊', { active: true }),
    wushuang: S('无双', { locked: true }), lijian: S('离间', { active: true }), biyue: S('闭月'), jianxiong: S('奸雄'),
    hujia: S('护驾', { lord: true }), fankui: S('反馈'), guicai: S('鬼才'), ganglie: S('刚烈'), tuxi: S('突袭'),
    luoyi: S('裸衣'), tiandu: S('天妒'), yiji: S('遗计'), qingguo: S('倾国'), luoshen: S('洛神'),
    // 风
    liegong: S('烈弓'), kuanggu: S('狂骨', { locked: true }), shensu: S('神速'), jushou: S('据守'),
    tianxiang: S('天香'), hongyan: S('红颜', { locked: true }), buqu: S('不屈', { locked: true }), leiji: S('雷击'),
    guidao: S('鬼道'), huangtian: S('黄天', { lord: true }), guhuo: S('蛊惑'),
    // 火
    qiangxi: S('强袭'), quhu: S('驱虎'), jieming: S('节命'), lianhuan: S('连环'), niepan: S('涅槃', { limited: true }),
    bazhen: S('八阵', { locked: true }), huoji: S('火计'), kanpo: S('看破'), tianyi: S('天义'), mengjin: S('猛进'),
    shuangxiong: S('双雄'), luanji: S('乱击'), xueyi: S('血裔', { lord: true, locked: true }),
    // 林
    duanliang: S('断粮'), xingshang: S('行殇'), fangzhu: S('放逐'), songwei: S('颂威', { lord: true }),
    yinghun: S('英魂'), jiuchi: S('酒池'), rourin: S('肉林', { locked: true }), bengqiang: S('崩坏', { locked: true }),
    baonue: S('暴虐', { lord: true }), juxiang: S('巨象', { locked: true }), lieren: S('烈刃'), huoshou: S('祸首', { locked: true }),
    zaiqi: S('再起'), wansha: S('完杀', { locked: true }), luanwu: S('乱武', { limited: true }), weimu: S('帷幕', { locked: true }),
    haoshi: S('好施'), dimeng: S('缔盟'),
    // 山
    qiaobian: S('巧变'), tuntian: S('屯田'), zaoxian: S('凿险', { awaken: true }), jixi: S('急袭', { desc: '你可以将一张「田」当【顺手牵羊】使用。' }), tiaoxin: S('挑衅'),
    zhiji: S('志继', { awaken: true }), xiangle: S('享乐', { locked: true }), fangquan: S('放权'), ruoyu: S('若愚', { lord: true, awaken: true }),
    jiang: S('激昂'), hunzi: S('魂姿', { awaken: true }), zhiba: S('制霸', { lord: true }), zhijian: S('直谏'),
    guzheng: S('固政'), huashen: S('化身'), xinsheng: S('新生'), beige: S('悲歌'), duanchang: S('断肠', { locked: true }),
    // 变体扩展包：无基础武将的三名武将（原文案取自 list6.sgs）
    zhuhai: S('诛害', { desc: '其他角色的结束阶段，若其本回合造成过伤害，你可以对其使用一张【杀】。' }),
    qianxin: S('潜心', { awaken: true, desc: '觉醒技，当你造成伤害后，若你已受伤，你减少1点体力上限并获得“荐言”。' }),
    jianyan: S('荐言', { active: true, desc: '出牌阶段限一次，你可以声明一种牌的类型或颜色，然后将牌堆顶第一张符合你声明的牌交给一名男性角色。' }),
    yicong: S('义从', { locked: true, desc: '锁定技，你计算与其他角色的距离-1；若你的体力值不大于2，其他角色计算与你的距离+1。' }),
    qiaomeng: S('趫猛', { desc: '当你使用【杀】对一名角色造成伤害后，你可以弃置其区域里的一张牌。若此牌为坐骑牌，你获得之。' }),
    // 界/Po 差异化技能：技能 id 独立，只有 pack='extras' 的变体武将携带，基础 57 将不受影响
    j_rende: S('仁德', { variant: '界', desc: '出牌阶段，每名角色限一次，你可以交给一名其他角色任意张手牌。当你本阶段以此法给出第二张牌时，你可以视为使用一张基本牌（使用【杀】有次数限制）。' }),
    j_jijiang: S('激将', { variant: '界', lord: true, desc: '主公技，其他蜀势力角色可以在你需要时代替你使用或打出【杀】（视为由你使用或打出）；每回合限一次，其他蜀势力角色于其回合外使用、打出或替你使用或打出【杀】时，其可以令你摸一张牌。' }),
    j_wusheng: S('武圣', { variant: 'Po', desc: '你可以将一张红色牌当【杀】使用或打出。你使用的方块【杀】无距离限制。' }),
    j_paoxiao: S('咆哮', { variant: 'Po', locked: true, desc: '锁定技，你使用【杀】无次数限制。当你使用的【杀】被抵消后，你本回合下一次【杀】造成的伤害+1。' }),
    j_tishen: S('替身', { variant: 'Po', limited: true, desc: '限定技，准备阶段，你可以回复所有体力，然后摸X张牌（X为你回复的体力值）。' }),
    j_longdan: S('龙胆', { variant: 'Po', desc: '你可以将一张【杀】当【闪】、【闪】当【杀】、【酒】当【桃】、【桃】当【酒】使用或打出。' }),
    j_qinxue: S('勤学', { variant: 'Po', awaken: true, desc: '觉醒技，准备阶段或结束阶段，若你的手牌数比体力值多2或更多，你减少1点体力上限，回复1点体力或摸两张牌，然后获得“攻心”。' }),
    gongxin: S('攻心', { variant: 'Po', active: true, desc: '出牌阶段限一次，你可以观看一名其他角色的手牌，然后你可以展示其中一张红桃牌并选择一项：1.弃置此牌；2.将此牌置于牌堆顶。' }),
    j_lianying: S('连营', { variant: 'Po', desc: '当你失去所有手牌后，你可以令至多X名角色各摸一张牌（X为你失去的手牌数）。' }),
    j_jianxiong: S('奸雄', { variant: 'Po', desc: '当你受到伤害后，你可以摸一张牌，并获得造成此伤害的牌。' }),
    j_yiji: S('遗计', { variant: 'Po', desc: '当你受到1点伤害后，你可以摸两张牌，然后你可以交给至多两名其他角色共计至多两张手牌。' }),
    j_guicai: S('鬼才', { variant: 'Po', desc: '当一张判定牌生效前，你可以用一张牌代替之。' }),
    j_fankui: S('反馈', { variant: 'Po', desc: '当你受到1点伤害后，你可以获得伤害来源的一张牌。' }),
    j_ganglie: S('刚烈', { variant: 'Po', desc: '当一名角色对你造成1点伤害后，你可以判定，若结果为：红色，你对其造成1点伤害；黑色，你弃置其一张牌。' }),
    j_zhiheng: S('制衡', { variant: '界', active: true, desc: '出牌阶段限一次，你可以弃置任意张牌，然后摸等量张牌，若你以此法弃置了所有手牌，你额外摸一张牌。' }),
    j_biyue: S('闭月', { variant: 'Po', desc: '结束阶段，若你没有手牌，你可以摸两张牌，否则你可以摸一张牌。' }),
    j_guanxing: S('观星', { variant: 'Po', desc: '准备阶段，你可以观看牌堆顶的五张牌（存活角色数小于4时改为三张），然后将之以任意顺序置于牌堆顶或牌堆底。若皆置于牌堆底，结束阶段你可以再次发动本技能。' }),
    j_kurou: S('苦肉', { variant: 'Po', active: true, desc: '出牌阶段限一次，你可以弃置一张牌，然后失去1点体力。' }),
    j_zhaxiang: S('诈降', { variant: 'Po', locked: true, desc: '锁定技，当你失去1点体力后，你摸三张牌，若在你的出牌阶段，你本回合使用【杀】的限制次数+1、使用红色【杀】无距离限制且不能被抵消。' }),
    j_tuxi: S('突袭', { variant: 'Po', desc: '摸牌阶段，你可以少摸任意张牌并获得等量其他角色的各一张手牌。' }),
    j_yaowu: S('耀武', { variant: 'Po', locked: true, desc: '锁定技，当你受到伤害时，若造成伤害的牌：为红色，伤害来源摸一张牌；不为红色，你摸一张牌。' }),
    shizhan: S('势斩', { variant: 'Po', active: true, desc: '出牌阶段限两次，你可以令一名其他角色视为对你使用一张【决斗】。' }),
    j_fanjian: S('反间', { variant: 'Po', active: true, desc: '出牌阶段限一次，你可以展示并交给一名其他角色一张手牌，其选择一项：1.展示所有手牌，弃置与此牌相同花色的牌；2.失去1点体力。' }),
    // P2：界/Po 变体第二批
    j_yijue: S('义绝', { variant: 'Po', active: true, desc: '出牌阶段限一次，你可以弃置一张牌，然后令一名其他角色展示一张手牌。若此牌为：黑色，其本回合非锁定技失效且不能使用或打出手牌，你本回合对其使用的红桃【杀】伤害+1；红色，你获得之，然后你可以令其回复1点体力。' }),
    j_tieji: S('铁骑', { variant: 'Po', desc: '当你使用【杀】指定目标后，你可以令其本回合非锁定技失效，然后你判定，除非其弃置一张与判定结果花色相同的牌，否则其不能抵消此【杀】。' }),
    j_yingzi: S('英姿', { variant: 'Po', locked: true, desc: '锁定技，摸牌阶段，你多摸一张牌。你的手牌上限为你的体力上限。' }),
    j_guose: S('国色', { variant: 'Po', active: true, desc: '出牌阶段限一次，你可以选择一项，然后摸一张牌：1.将一张方块牌当【乐不思蜀】使用；2.弃置一张方块牌和场上一张【乐不思蜀】。' }),
    j_luoyi: S('裸衣', { variant: 'Po', desc: '摸牌阶段开始前，你可以亮出牌堆顶的三张牌，然后你可以跳过摸牌阶段并获得其中所有基本牌、武器牌和【决斗】，且直到你的下回合开始，你为伤害来源的【杀】和【决斗】对目标角色造成的伤害+1。' }),
    j_luoshen: S('洛神', { variant: 'Po', desc: '准备阶段，你可以判定，若结果为黑色，你获得此牌，然后你可以重复此流程。以此法获得的牌本回合不计入手牌上限。' }),
    j_jieyin: S('结姻', { variant: 'Po', active: true, desc: '出牌阶段限一次，你可以选择一名男性角色，弃置一张手牌或将一张装备牌置入其装备区，然后你与其中体力值较大的角色摸一张牌，体力值较小的角色回复1点体力。' }),
    j_jizhi: S('集智', { variant: 'Po', desc: '当你使用非转化锦囊牌时，你可以摸一张牌，若此牌是基本牌，你可以弃置此牌令你本回合手牌上限+1。' }),
    j_qicai: S('奇才', { variant: 'Po', locked: true, desc: '锁定技，你使用锦囊牌无距离限制。当其他角色弃置你装备区里的防具或宝物牌时，你防止之。' }),
    j_jiuyuan: S('救援', { variant: 'Po', lord: true, desc: '主公技，其他吴势力角色于其回合内回复体力时，若其体力值大于等于你，则其可以改为令你回复1点体力，然后其摸一张牌。' }),
    j_liyu: S('利驭', { variant: 'Po', desc: '当你使用【杀】对其他角色造成伤害后，你可以获得其区域里的一张牌，若获得的牌：不为装备牌，其摸一张牌；为装备牌，你视为对由其指定的另一名角色使用一张【决斗】。' }),
    j_chuli: S('除疠', { variant: 'Po', active: true, desc: '出牌阶段限一次，你可以选择任意名势力各不相同的其他角色，弃置你和这些角色的各一张牌，然后被弃置黑桃牌的角色各摸一张牌。' }),
    // P3：第三批
    j_yajiao: S('涯角', { variant: 'Po', desc: '当你于回合外使用或打出手牌时，你可以展示牌堆顶一张牌，若这两张牌类型：相同，你可以令一名角色获得展示牌；不同，你可以弃置攻击范围内包含你的一名角色区域里的一张牌。' }),
    j_fenwei: S('奋威', { variant: 'Po', limited: true, desc: '限定技，当一张锦囊牌指定多个目标后，你可以令此牌对任意个目标无效。' }),
    j_qianxun: S('谦逊', { variant: 'Po', desc: '当一张延时锦囊牌或其他角色使用的普通锦囊牌对你生效时，若你为唯一目标，你可以将所有手牌移出游戏直到回合结束。' }),
    j_hujia: S('护驾', { variant: 'Po', lord: true, desc: '主公技，其他魏势力角色可以在你需要时代替你使用或打出【闪】（视为由你使用或打出）；每回合限一次，当其他魏势力角色于其回合外使用或打出【闪】时，其可以令你摸一张牌。' }),
    j_qingjian: S('清俭', { variant: 'Po', desc: '每回合限一次，当你在摸牌阶段外获得牌后，你可以展示并交给一名其他角色任意张牌，令当前回合角色本回合手牌上限+X（X为你给出牌的类型数）。' }),
    j_chongzhen: S('冲阵', { variant: 'SP', desc: '当你发动“龙胆”时，你可以获得对方的一张手牌。' }),
    j_liegong: S('烈弓', { variant: 'Po', desc: '当你于出牌阶段使用【杀】指定目标后，若其手牌数不小于你的体力值或不大于你的攻击范围，你可以令其不能抵消此【杀】。' }),
    // New1V1 独立将池（晋），技能 id 独立，不进入基础/扩展包
    j_xijue: S('袭爵', { desc: '游戏开始时，你获得4枚“爵”标记；结束阶段，你获得X枚“爵”（X为你本回合造成的伤害数）。摸牌阶段开始时，你可以移除1枚“爵”发动“突袭”；其他角色的结束阶段，你可以移除1枚“爵”发动“骁果”。' }),
    j_shidu: S('识度', { active: true, desc: '出牌阶段限一次，你可以拼点：若你赢，你获得被拼点者的所有手牌，然后交给其你一半的手牌（向下取整）。' }),
    j_yimie: S('夷灭', { desc: '每回合限一次，当你对其他角色造成伤害时，你可以失去1点体力，令此伤害+X（X为其体力值减本次伤害值），造成伤害后，其回复X点体力。' }),
    j_tairan: S('泰然', { locked: true, desc: '锁定技，结束阶段，你回复所有体力，将手牌摸至体力上限。出牌阶段开始时，你失去以此法回复的体力，弃置你以此法获得的手牌。' }),
    j_choufa: S('筹伐', { active: true, desc: '出牌阶段限一次，你可以展示一名其他角色一张手牌，其与此牌类型不同的手牌均视为【杀】直到其回合结束。' }),
    j_yanxi: S('宴戏', { active: true, desc: '出牌阶段限一次，你可以令一名其他角色的随机一张手牌与牌堆顶的两张牌混合，你猜测来自其手牌的牌：若猜对，你获得全部三张牌；若猜错，你获得选中的牌。你以此法获得的牌本回合不计入手牌上限。' }),
    j_sanchen: S('三陈', { active: true, desc: '出牌阶段限一次，你可以令一名角色摸三张牌，然后弃置三张牌。若其以此法弃置的牌类型均不同，其摸一张牌，本技能视为未发动且本回合不能指定其为目标。' }),
    j_huishi: S('慧识', { desc: '摸牌阶段，你可以改为观看牌堆顶的X张牌（X为牌堆中牌数的个位数），获得其中的一半（向下取整），然后将剩余牌置入牌堆底。' }),
  };
  // 原版「武将等阶」：0-4，>=4 才显示金色指向线的高品质金龙层。
  // 单机无养成，按新号 0 阶处理（严格对照原版）；要给某将开启可在此填 4。
  const GENERAL_GRADATION = {};
  GENERALS.forEach((g) => { g.gradation = GENERAL_GRADATION[g.name] || 0; });

  // 用官方文案补全 desc
  const DESC = global.SGS_SKILL_DESC || {};
  for (const k of Object.keys(SKILLS)) {
    if (!SKILLS[k].desc) SKILLS[k].desc = DESC[SKILLS[k].name] || '';
  }

  // 斗地主农民技能（仅 mode==='ddz' 时由引擎授予；不进入 57 将技能表）
  SKILLS.juzhong = { name: '聚众', ddz: true, desc: '当农民的队友使用一张基本牌时，你可以弃置一张同名基础牌强化此牌效果：【杀】伤害+1；【闪】响应生效后弃置一名角色一张牌；【桃】生效后可以摸两张牌；【酒】的回复量+1或令使用的下一张【杀】的伤害额外+1。' };
  SKILLS.gongji = { name: '共济', ddz: true, limited: true, desc: '限定技，当你的队友受到伤害时，你可以弃置一张牌并转移此伤害至你。' };

  const DUEL_POOL = ['黄月英','孙权','黄盖','周瑜','陆逊','吕布','黄忠','魏延','夏侯渊','周泰','于吉','典韦','太史慈','庞德','孙坚','祝融','贾诩','姜维','孙策'];
const PACKS = [
    { id: 'standard', name: '标准包', generals: GENERALS.filter((g) => g.pack === '标准') },
    { id: 'wind', name: '神话再临·风', generals: GENERALS.filter((g) => g.pack === '风') },
    { id: 'fire', name: '神话再临·火', generals: GENERALS.filter((g) => g.pack === '火') },
    { id: 'forest', name: '神话再临·林', generals: GENERALS.filter((g) => g.pack === '林') },
    { id: 'mountain', name: '神话再临·山', generals: GENERALS.filter((g) => g.pack === '山') },
  ];

  // 变体扩展包：默认关闭。启用方式（main/ui 均可调用）：
  //   new SGS.Game({ packs: ['标准', ..., 'extras'] })  或  new SGS.Game({ extras: true })
  //   game.setExtras(true) 必须在 start()（setup 选将池）之前调用；EXTRAS_PACK.defaultEnabled === false。
  const EXTRAS_PACK = {
    id: 'extras',
    name: '变体扩展包',
    defaultEnabled: false,
    generals: GENERALS.filter((g) => g.pack === 'extras'),
  };
  const isExtrasEnabled = (packs) => (packs || []).indexOf('extras') >= 0;

  global.SGS_DATA = { SUITS, RANK_CN, CARDS, DECK_STANDARD, DECK_MANEUVERING, DECK_1V1_BAN, DECK_DDZ, DDZ_MAX_MULTIPLE, DDZ_SCENES, GENERALS, SKILLS, KINGDOM_COLOR, PACKS, DUEL_POOL, GENERAL_GRADATION, EXTRA_GENERALS, EXTRAS_PACK, isExtrasEnabled, NEW_DUEL_GENERALS, NEW_DUEL_BASE_NAMES, NEW_DUEL_PACK };
})(typeof window !== 'undefined' ? window : globalThis);
