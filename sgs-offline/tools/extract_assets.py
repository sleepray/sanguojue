#!/usr/bin/env python3
"""从三国杀OL APK 资源包中抽取单机版所需的最小素材集。
- 武将立绘：LocalH5Picture/general/big/static，图名 = 武将ID*100，535x678
- 卡牌牌面：Res/Picture/Cards，126x174
"""
import os, re, glob, json, sys
import UnityPy
from PIL import Image

SRC = '/Users/chenlei/WorkBuddy/2026-10-26-13-50-39/sgs_offline/assets/Bundles'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_P = os.path.join(ROOT, 'assets', 'portraits')
OUT_C = os.path.join(ROOT, 'assets', 'cards')

def save_sprite(obj, path):
    img = obj.read().image
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    img.save(path, 'PNG')
    return img.size

def extract_portraits():
    made = {}
    for f in sorted(glob.glob(os.path.join(SRC, '*general_big_static*'))):
        env = UnityPy.load(f)
        for o in env.objects:
            if o.type.name != 'Sprite':
                continue
            d = o.read()
            try:
                gid = int(d.m_Name) // 100
            except ValueError:
                continue
            if not (1 <= gid <= 60):
                continue
            dst = os.path.join(OUT_P, f'{gid:03d}.png')
            if os.path.exists(dst):
                continue
            size = save_sprite(o, dst)
            made[gid] = size
    return made

CARD_MAP = {
 'Sha':'sha','Shan':'shan','Tao':'tao','Jiu':'jiu','HuoSha':'huosha','LeiSha':'leisha',
 'JueDou':'juedou','GuoHeChaiQiao':'guohe','ShunShouQianYang':'shunshou','WuZhongShengYou':'wuzhong',
 'JieDaoShaRen':'jiedao','NanManRuQin':'nanman','WanJianQiFa':'wanjian','TaoYuanJieYi':'taoyuan',
 'WuGuFengDeng':'wugu','WuXieKeJi':'wuxie','LeBuSiShu':'lebu','ShanDian':'shandian',
 'BingLiangCunDuan':'bingliang','ZhuGeLianNu':'zhugeliannu','QingGangJian':'qinggang',
 'CiXiongShuangGuJian':'cixiong','GuanShiFu':'guanshi','ZhangBaSheMao':'zhangba',
 'FangTianHuaJi':'fangtian','QiLinGong':'qilin','BaGuaZhen':'bagua','RenWangDun':'renwang',
 'TengJia':'tengjia','ChiTu':'chitu','DaWan':'dawan','DiLu':'dilu','HuaLiu':'hualiu',
 'JueYing':'jueying','ZiXing':'zixing','ZhuaHuangFeiDian':'zhuahuang',
}

def extract_cards():
    made = {}
    f = glob.glob(os.path.join(SRC, 'assets_res_picture_cards_*.ab'))[0]
    env = UnityPy.load(f)
    for o in env.objects:
        if o.type.name != 'Sprite':
            continue
        d = o.read()
        name = d.m_Name
        m = re.match(r'^(\w+)_png$', name)
        if not m:
            continue
        base = m.group(1)
        if base not in CARD_MAP:
            continue
        dst = os.path.join(OUT_C, CARD_MAP[base] + '.png')
        if os.path.exists(dst):
            continue
        size = save_sprite(o, dst)
        made[CARD_MAP[base]] = size
    # 牌背：尝试从同包取 EmptyCard_png 或其它
    for o in env.objects:
        if o.type.name == 'Sprite':
            d = o.read()
            if d.m_Name in ('EmptyCard_png','baseCardType'):
                save_sprite(o, os.path.join(ROOT,'assets','cardback_'+d.m_Name+'.png'))
    return made

if __name__ == '__main__':
    os.makedirs(OUT_P, exist_ok=True); os.makedirs(OUT_C, exist_ok=True)
    p = extract_portraits(); c = extract_cards()
    print('portraits', len(p), 'cards', len(c))
    json.dump({'portraits':{str(k):v for k,v in p.items()},'cards':c},
              open(os.path.join(ROOT,'assets','_extract_report.json'),'w'), ensure_ascii=False, indent=1)
