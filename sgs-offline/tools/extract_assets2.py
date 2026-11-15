#!/usr/bin/env python3
"""导出 57 将（标准25 + 风火林山32）座位/大立绘，以及标准+军争全部牌面。"""
import os, re, glob, json
import UnityPy

SRC = '/Users/chenlei/WorkBuddy/2026-10-26-13-50-39/sgs_offline/assets/Bundles'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_BIG = os.path.join(ROOT, 'assets', 'big')
OUT_SEAT = os.path.join(ROOT, 'assets', 'seat')
OUT_C = os.path.join(ROOT, 'assets', 'cards')
for d in (OUT_BIG, OUT_SEAT, OUT_C): os.makedirs(d, exist_ok=True)

def save(o, path):
    img = o.read().image
    if img.mode != 'RGBA': img = img.convert('RGBA')
    img.save(path, 'PNG')

# ---- 大立绘 535x678 ----
big = {}
for f in sorted(glob.glob(os.path.join(SRC, '*general_big_static*'))):
    env = UnityPy.load(f)
    for o in env.objects:
        if o.type.name != 'Sprite': continue
        d = o.read()
        try: gid = int(d.m_Name) // 100
        except ValueError: continue
        if not (1 <= gid <= 57): continue
        dst = os.path.join(OUT_BIG, f'{gid:03d}.png')
        if not os.path.exists(dst): save(o, dst)
        big[gid] = (int(d.m_Rect.width), int(d.m_Rect.height))

# ---- 座位立绘 ----
seat = {}
for f in sorted(glob.glob(os.path.join(SRC, '*general_seat_static*'))):
    env = UnityPy.load(f)
    for o in env.objects:
        if o.type.name != 'Sprite': continue
        d = o.read()
        try: gid = int(d.m_Name) // 100
        except ValueError: continue
        if not (1 <= gid <= 57): continue
        dst = os.path.join(OUT_SEAT, f'{gid:03d}.png')
        if not os.path.exists(dst): save(o, dst)
        seat[gid] = (int(d.m_Rect.width), int(d.m_Rect.height))

# ---- 卡面 ----
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
 'HuoGong':'huogong','TieSuoLianHuan':'tiesuo','GuDingDao':'gudingdao','BaiYinShiZi':'baiyinshizi',
}
made = {}
f = glob.glob(os.path.join(SRC, 'assets_res_picture_cards_*.ab'))[0]
env = UnityPy.load(f)
for o in env.objects:
    if o.type.name != 'Sprite': continue
    d = o.read()
    m = re.match(r'^(\w+)_png$', d.m_Name)
    if not m: continue
    base = m.group(1)
    if base not in CARD_MAP: continue
    dst = os.path.join(OUT_C, CARD_MAP[base] + '.png')
    if not os.path.exists(dst): save(o, dst)
    made[CARD_MAP[base]] = (int(d.m_Rect.width), int(d.m_Rect.height))

print('big', len(big), 'seat', len(seat), 'cards', len(made))
print('big missing', [i for i in range(1,58) if i not in big])
print('seat missing', [i for i in range(1,58) if i not in seat])
print('cards', sorted(made))
json.dump({'big':big,'seat':seat,'cards':made}, open(os.path.join(ROOT,'assets','_extract_report2.json'),'w'), ensure_ascii=False, indent=1)
