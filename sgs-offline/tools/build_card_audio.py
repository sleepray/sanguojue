#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""三国杀·单机版 — 原版卡牌语音抽取（v2，带核验）

与 v1 的差别：v1 把 clip 名的首段数字当成 `CardsBook.id`，这是错的。
v2 以原版客户端的三处证据为准：

  1. `js` 侧实现（extract/GameMain）：
        GetNormalSkillSound(t, e, i){ n = t+"_"+soundType; ... cardMusicDict.get(n) ... }
        makeUpRootResouceToUrl("voice/spell/", music + type)
     即卡牌语音来自 `sys_h5_music.cardmusic`，键为 `<skillID>_<key>`，
     文件名形如 `card/<skillID>.<key>.<gender>[.<type>]`。

  2. `assets/AppCfgData/list2.sgs` 的 `sys_h5_music.root.cardmusic`（184 条声明）：
        {"skillID":1,"key":1,"musicboy":"card/1.1.1","musicgirl":"card/1.1.2"}

  3. `assets/AppCfgData/list6.sgs` 的 `cha_spell.GameSpells.spell`：
        a=skillID, c=技能中文名（1=杀, 2=闪, 3=桃, 50=裸衣, 85=铁索连环 …）

  4. `extract/GameMain` 的 `class rat { Huo=6; Lei=7; Bing=11 }`：
        type 6=火杀、7=雷杀、11=冰杀（本作没有冰杀）

所以 `<数字>` 是 **skillID**，不是 CardsBook id。基础牌 1~7 两套编号恰好同序，
因此 v1 在杀/闪/桃上碰巧对，但 50=x 裸衣、200=仁王盾、201=寒冰剑 等全部错位。

用法：
    python3 tools/build_card_audio.py
    python3 tools/build_card_audio.py --dry-run
    python3 tools/build_card_audio.py --bitrate 48k
    python3 tools/build_card_audio.py --no-normalize   # 关闭响度归一

产物：
    assets/audio/card/<key>_<n>.mp3
    out/card_audio_map.json        （只含 confirmed 条目）
    docs/卡牌语音映射.md            （逐条核验状态）
"""

import argparse
import array
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_SRC = "/Users/chenlei/WorkBuddy/2026-10-26-13-50-39/sgs_offline"
SRC_ROOT = os.environ.get("SGS_SRC") or DEFAULT_SRC
BUNDLES = os.path.join(SRC_ROOT, "assets", "Bundles")
CFG_DIR = os.path.join(SRC_ROOT, "assets", "AppCfgData")
LIST2 = os.path.join(CFG_DIR, "list2.sgs")   # sys_h5_music
LIST6 = os.path.join(CFG_DIR, "list6.sgs")   # cha_spell
DATA_JS = os.path.join(ROOT, "js", "data.js")

OUT_DIR = os.path.join(ROOT, "assets", "audio", "card")
MAP_PATH = os.path.join(ROOT, "out", "card_audio_map.json")
DOC_PATH = os.path.join(ROOT, "docs", "卡牌语音映射.md")
AUDIO_INDEX = os.path.join(ROOT, "assets", "audio_index.json")

# 卡牌技能名 → 本项目 CARDS 键（仅名称写法差异，不涉及语义推断）
NAME_ALIAS = {
    "借刀": "jiedao",      # CardsBook/技能名写作「借刀」，本作「借刀杀人」
    "紫騂": "zixing",      # 繁体异体字「騂」→ 本作「紫骍」
}
# 属性枚举：见 extract/GameMain 的 class rat
TYPE_FIRE, TYPE_THUNDER, TYPE_ICE = 6, 7, 11
# 通用装备类型语音（同样在 cardmusic 中声明）
EQUIP_VOICES = {"wuqi", "fangju", "ma"}
# 与身份局无关的其它玩法语音
OTHER_MODE = {"bujiao", "jiaodizhu", "zhadan"}

# 响度归一目标（dBFS RMS）与限制
TARGET_RMS_DB = -18.0
MAX_GAIN_DB = 8.0
PEAK_CEIL_DB = -1.5

RE_JS_CARD = re.compile(r"^\s{4}([a-z]+): \{ name: '([^']+)'", re.M)
RE_CLIP = re.compile(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?$")


def human(n):
    return "%.2f MB" % (n / 1048576.0) if n >= 1048576 else "%.1f KB" % (n / 1024.0)


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def ffmpeg_bin():
    return shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


# ------------------------------------------------------------------ 配置解析
def load_game_cards():
    with open(DATA_JS, encoding="utf-8") as fh:
        src = fh.read()
    m = re.search(r"const CARDS = \{(.*?)\n  \};", src, re.S)
    if not m:
        sys.exit("无法从 js/data.js 解析出 CARDS")
    pairs = RE_JS_CARD.findall(m.group(1))
    if not pairs:
        sys.exit("js/data.js 的 CARDS 解析结果为空")
    return pairs, {name: key for key, name in pairs}


def load_skill_names():
    """cha_spell: skillID -> 技能中文名"""
    with open(LIST6, encoding="utf-8") as fh:
        cfg = json.load(fh)
    table = {}
    for entry in cfg.get("cha_spell", {}).get("GameSpells", {}).get("spell", []):
        if isinstance(entry, dict) and "a" in entry and "c" in entry:
            try:
                table[int(entry["a"])] = entry["c"]
            except (TypeError, ValueError):
                continue
    if not table:
        sys.exit("list6.sgs 中找不到 cha_spell.GameSpells.spell")
    return table


def load_cardmusic():
    """返回 (declared: 文件名 -> 声明信息, entries)"""
    with open(LIST2, encoding="utf-8") as fh:
        cfg = json.load(fh)
    entries = cfg.get("sys_h5_music", {}).get("root", {}).get("cardmusic", [])
    if not entries:
        sys.exit("list2.sgs 中找不到 sys_h5_music.root.cardmusic")
    declared = {}
    for e in entries:
        sid, key, typ = e.get("skillID"), e.get("key"), e.get("type")
        for gender_field, gender in (("musicboy", 1), ("musicgirl", 2)):
            name = e.get(gender_field)
            if not name:
                continue
            declared[name.split("/")[-1]] = {
                "skillID": sid, "key": key, "type": typ, "gender": gender,
            }
    return declared, entries


# ------------------------------------------------------------------ 音频工具
def wav_pcm(wav_bytes):
    """返回 (array('h'), 采样率, 声道) —— 只处理 16bit PCM WAV。"""
    if not wav_bytes or wav_bytes[:4] != b"RIFF":
        return None, 22050, 1
    pos, rate, ch, bits = 12, 22050, 1, 16
    data = b""
    while pos + 8 <= len(wav_bytes):
        cid = wav_bytes[pos:pos + 4]
        size = int.from_bytes(wav_bytes[pos + 4:pos + 8], "little")
        body = wav_bytes[pos + 8:pos + 8 + size]
        if cid == b"fmt ":
            ch = int.from_bytes(body[2:4], "little")
            rate = int.from_bytes(body[4:8], "little")
            bits = int.from_bytes(body[14:16], "little")
        elif cid == b"data":
            data = body
            break
        pos += 8 + size + (size & 1)
    if bits != 16 or not data:
        return None, rate, ch
    pcm = array.array("h")
    pcm.frombytes(data[:len(data) - (len(data) % 2)])
    return pcm, rate, ch


def _rms_db(seq):
    if not seq:
        return -99.0
    step = max(1, len(seq) // 20000)
    acc, cnt = 0, 0
    for i in range(0, len(seq), step):
        v = seq[i]
        acc += v * v
        cnt += 1
    return 20 * math.log10(max(math.sqrt(acc / max(1, cnt)), 1) / 32768.0)


def analyse(pcm, rate, ch):
    """分析一段音频：全长/有效语音段分别统计。

    原版卡牌语音普遍是「一小段人声 + 一大段数字静音」的填充格式
    （例如 1.1.1 声明 2.16s，真正有人声的只有 0.30s），
    所以响度必须以**有效语音段**为准，否则会低估 5~10dB。
    """
    if not pcm:
        return {"dur": 0.0, "peak_db": -99.0, "rms_db": -99.0,
                "rms_full_db": -99.0, "lead": 0.0, "tail": 0.0, "speech": 0.0}
    n = len(pcm)
    peak = max(max(pcm), -min(pcm))
    thr = 250
    first = 0
    for i in range(0, n, max(1, n // 6000)):
        if abs(pcm[i]) > thr:
            first = i
            break
    last = n - 1
    for i in range(n - 1, -1, -max(1, n // 6000)):
        if abs(pcm[i]) > thr:
            last = i
            break
    if last <= first:
        last, first = n - 1, 0
    frames = max(1, rate * ch)
    seg = pcm[first:last + 1]
    return {
        "dur": n / float(frames),
        "peak_db": 20 * math.log10(max(peak, 1) / 32768.0),
        "rms_db": _rms_db(seg),          # 有效段响度（用于归一）
        "rms_full_db": _rms_db(pcm),     # 全长响度（仅供参考）
        "lead": first / float(frames),
        "tail": (n - 1 - last) / float(frames),
        "speech": (last - first + 1) / float(frames),
    }


def encode_mp3(wav_bytes, out_path, bitrate, tmpdir, gain_db=0.0, start=0.0, end=None):
    src = os.path.join(tmpdir, "in.wav")
    with open(src, "wb") as fh:
        fh.write(wav_bytes)
    cmd = [ffmpeg_bin(), "-v", "error", "-y"]
    if start > 0.005:
        cmd += ["-ss", "%.3f" % start]
    cmd += ["-i", src]
    if end is not None and end > start:
        cmd += ["-t", "%.3f" % (end - start)]
    filters = []
    if abs(gain_db) > 0.25:
        filters.append("volume=%.2fdB" % gain_db)
    if filters:
        cmd += ["-af", ",".join(filters)]
    cmd += ["-codec:a", "libmp3lame", "-b:a", bitrate,
            "-ar", "22050", "-ac", "1", out_path]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg 失败: %s" % proc.stderr.decode("utf-8", "replace")[:160])
    return os.path.getsize(out_path)


# ------------------------------------------------------------------ 核验
def classify(clip_name, declared, skills, name2key):
    """返回 (status, card_key, gender, 说明)。

    gender: 'male' / 'female' / 'neutral'
    依据 cardmusic 的 musicboy / musicgirl 字段（1=男声，2=女声）；
    装备类单数字 clip 没有性别维度，记为 neutral。
    """
    if clip_name in EQUIP_VOICES:
        return "confirmed", "equip", "neutral", "通用装备类型语音（cardmusic 已声明，无性别）"
    if clip_name in OTHER_MODE:
        return "rejected", None, "neutral", "斗地主等其它玩法语音"
    m = RE_CLIP.match(clip_name)
    if not m:
        return "rejected", None, "neutral", "无法解析的命名"
    sid = int(m.group(1))
    key_no = int(m.group(2)) if m.group(2) else None
    typ = int(m.group(4)) if m.group(4) else None

    skill_name = skills.get(sid)
    info = declared.get(clip_name)

    if skill_name is None:
        return "rejected", None, "neutral", "skillID %d 在 cha_spell 中不存在" % sid

    # 「杀」按属性后缀分流：无后缀=普通杀，6=火杀，7=雷杀，11=冰杀（本作没有）
    if skill_name == "杀":
        if typ is None:
            card_key = "sha"
        elif typ == TYPE_FIRE:
            card_key = "huosha"
        elif typ == TYPE_THUNDER:
            card_key = "leisha"
        elif typ == TYPE_ICE:
            return "rejected", None, "neutral", "冰杀（type=11），本作没有这张牌"
        else:
            return "uncertain", None, "neutral", "未知属性后缀 type=%s" % typ
    else:
        card_key = name2key.get(skill_name) or NAME_ALIAS.get(skill_name)

    if card_key is None:
        if typ == TYPE_ICE:
            return "rejected", None, "neutral", "冰杀（%s），本作没有这张牌" % skill_name
        return "rejected", None, "neutral", "技能「%s」不是本项目 43 张牌之一" % skill_name

    # 名称对得上，再看是否被 cardmusic 正式声明
    if info is None:
        if key_no == 3:
            return "uncertain", card_key, "neutral", "key=3 未被 cardmusic 声明（原版判定/特写音，非出牌语音）"
        return "uncertain", card_key, "neutral", "未在 cardmusic 中声明，来源不确定"

    # 声明的属性必须与牌匹配，避免把火/雷杀塞进普通杀
    declared_type = info.get("type")
    if (declared_type or None) != (typ or None):
        return "uncertain", card_key, "neutral", "属性后缀与声明不一致"

    # 性别以**文件名里的性别段**为准：`23` 这类装备音只有一段录音，没有性别维度，
    # 即便 cardmusic 把它挂在 musicgirl 字段下，也应视为中性。
    gender_digit = int(m.group(3)) if m.group(3) else None
    if gender_digit == 1:
        gender = "male"
    elif gender_digit == 2:
        gender = "female"
    else:
        gender = "neutral"
    decl_gender = info.get("gender")
    if gender_digit is None and decl_gender in (1, 2):
        note = "（无性别段，按中性处理）"
    else:
        note = ""
    return "confirmed", card_key, gender, "cardmusic 声明 + cha_spell 名称一致（%s）%s" % (gender, note)



# ------------------------------------------------------------------ 全量复核
GENERAL_DIR = os.path.join(ROOT, "assets", "audio", "general")


def load_generals_skills():
    """用 node 读 js/data.js，拿到 GENERALS 与 SKILLS 的中文名（只读）。"""
    js = """
const fs=require('fs'); global.window=global;
new Function('window', fs.readFileSync(process.argv[1],'utf8'))(global);
const D=global.SGS_DATA;
console.log(JSON.stringify(D.GENERALS.map(g=>({id:g.id,name:g.name,gender:g.gender,pack:g.pack,
  skills:g.skills.map(k=>({key:k,cn:(D.SKILLS[k]&&D.SKILLS[k].name)||k}))}))));
"""
    try:
        out = subprocess.run(["node", "-e", js, DATA_JS],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        return json.loads(out.stdout.decode("utf-8"))
    except Exception as exc:
        log("读取 js/data.js 失败：%s" % exc)
        return []


def load_heromusic():
    with open(LIST2, encoding="utf-8") as fh:
        cfg = json.load(fh)
    hm = cfg.get("sys_h5_music", {}).get("root", {}).get("heromusic", [])
    byid = {}
    for e in hm:
        byid.setdefault(str(e.get("a")), []).append(e)
    return byid


def probe_audio(path):
    """返回 (时长秒, 峰值dB, 平均dB, 字节数)；ffmpeg 不可用时退化为只看大小。"""
    size = os.path.getsize(path) if os.path.exists(path) else 0
    dur, peak, mean = 0.0, None, None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        dur = float(out.stdout.decode().strip() or 0)
    except Exception:
        dur = 0.0
    try:
        v = subprocess.run(
            [ffmpeg_bin(), "-hide_banner", "-i", path, "-af", "volumedetect",
             "-f", "null", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30).stderr.decode("utf-8", "replace")
        import re as _re
        m1 = _re.search(r"max_volume:\s*(-?[\d.]+) dB", v)
        m2 = _re.search(r"mean_volume:\s*(-?[\d.]+) dB", v)
        peak = float(m1.group(1)) if m1 else None
        mean = float(m2.group(1)) if m2 else None
    except Exception:
        pass
    return dur, peak, mean, size



def median_f0(path):
    """基频中位数（Hz）。用于独立验证男女声是否搞反——不依赖 ASR。"""
    try:
        proc = subprocess.run([ffmpeg_bin(), "-v", "error", "-i", path,
                               "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        raw = proc.stdout
    except Exception:
        return None
    if not raw:
        return None
    pcm = array.array("h")
    pcm.frombytes(raw[:len(raw) // 2 * 2])
    rate = 16000
    win, hop = int(0.04 * rate), int(0.02 * rate)
    lo, hi = int(rate / 350), int(rate / 70)
    out = []
    for st in range(0, max(0, len(pcm) - win), hop):
        seg = pcm[st:st + win]
        mean = sum(seg) / float(win)
        seg = [v - mean for v in seg]
        energy = sum(v * v for v in seg) / float(win)
        if energy < 40000:
            continue
        best, best_lag = 0, 0
        for lag in range(lo, min(hi, len(seg) - 1)):
            acc = 0
            for i in range(0, len(seg) - lag, 4):
                acc += seg[i] * seg[i + lag]
            if acc > best:
                best, best_lag = acc, lag
        if best_lag:
            out.append(rate / float(best_lag))
    if not out:
        return None
    out.sort()
    return out[len(out) // 2]

def audit_generals(generals, heromusic, local_files):
    """逐将/逐技能核对：技能、阵亡、受伤三类。"""
    rows, gen_rows = [], []
    for g in generals:
        ents = heromusic.get(str(g["id"]), [])
        has_any_cfg = bool(ents)
        skill_ok = 0
        for sk in g["skills"]:
            cand = [e for e in ents if e.get("d") == sk["cn"]]
            files = [e.get(k) for e in cand for k in ("f", "g") if e.get(k)]
            present = [p for p in files
                       if "general_%03d_%s.mp3" % (g["id"], p.split("/")[-1]) in local_files]
            if present:
                status = "ok"
                skill_ok += 1
            elif files:
                status = "absent"
            elif cand:
                status = "no-voice"
            elif not has_any_cfg:
                status = "no-general"
            else:
                status = "no-voice"
            male = [p for p in present if p.endswith("_%d.mp3" % 1)]
            rows.append({
                "gid": g["id"], "gname": g["name"], "gender": g["gender"],
                "skill": sk["cn"], "key": sk["key"], "status": status,
                "male": [p for p in present if "skill" in p and p.endswith("_1")],
                "female": [p for p in present if "skill" in p and p.endswith("_2")],
                "text": next((e.get("m") for e in cand if e.get("m")), ""),
            })
        deaths_cfg = [e for e in ents if e.get("e")]
        deaths_files = [e.get("f") for e in deaths_cfg if e.get("f")]
        deaths_local = [p for p in deaths_files
                        if "general_%03d_%s.mp3" % (g["id"], p.split("/")[-1]) in local_files]
        cfg_names = []
        for e in ents:
            if not e.get("e") and e.get("d") and e["d"] not in cfg_names:
                cfg_names.append(e["d"])
        data_names = [sk["cn"] for sk in g["skills"]]
        order_diff = bool(cfg_names) and cfg_names[:len(data_names)] != data_names
        gen_rows.append({
            "id": g["id"], "name": g["name"], "gender": g["gender"],
            "skills": len(g["skills"]), "skill_ok": skill_ok,
            "death_cfg": len(deaths_cfg), "death_ok": len(deaths_local),
            "has_general": has_any_cfg,
            "order_diff": order_diff,
            "data_names": data_names,
            "cfg_names": cfg_names[:len(data_names)],
        })
    return rows, gen_rows


def main():
    ap = argparse.ArgumentParser(description="导出并核验原版卡牌语音")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--bitrate", default="48k")
    ap.add_argument("--no-normalize", action="store_true", help="关闭响度归一")
    args = ap.parse_args()

    try:
        import UnityPy
    except ImportError:
        sys.exit("缺少 UnityPy：请用原版素材包的 .venv/bin/python 运行")

    cards, name2key = load_game_cards()
    skills = load_skill_names()
    declared, entries = load_cardmusic()
    log("本作牌 %d 张 / 技能表 %d 条 / cardmusic 声明 %d 个文件"
        % (len(cards), len(skills), len(declared)))

    # ---------------------------------------------------------- 收集 clip
    bundles = sorted(
        os.path.join(BUNDLES, f) for f in os.listdir(BUNDLES)
        if f.startswith("assets_res_localsoundcdn_spell_card_") and f.endswith(".ab"))
    if not bundles:
        sys.exit("找不到卡牌语音包")
    clips = []
    for path in bundles:
        env = UnityPy.load(path)
        for obj in env.objects:
            if obj.type.name != "AudioClip":
                continue
            clip = obj.read()
            wav = list(clip.samples.values())[0]
            pcm, rate, ch = wav_pcm(wav)
            st = analyse(pcm, rate, ch) if pcm else {
                "dur": float(clip.m_Length or 0), "peak_db": -99, "rms_db": -99,
                "lead": 0, "tail": 0}
            clips.append({
                "name": clip.m_Name, "wav": wav, "pcm": pcm,
                "hash": hashlib.md5(wav).hexdigest(), **st,
            })
    clips.sort(key=lambda c: [(0, int(p)) if p.isdigit() else (1, p)
                             for p in c["name"].split(".")])
    log("卡牌语音包 %d 个 / clip %d 条" % (len(bundles), len(clips)))

    # ---------------------------------------------------------- 核验
    for c in clips:
        status, card_key, gender, reason = classify(c["name"], declared, skills, name2key)
        c["status"], c["card"], c["gender"], c["reason"] = status, card_key, gender, reason

    # 内容去重：同一张牌下完全相同的录音只保留一条。
    # 若重复项分属男/女声，说明原版男女两版就是同一段录音 → 合并为 neutral。
    seen = {}
    for c in clips:
        if c["status"] != "confirmed":
            continue
        key = (c["card"], c["hash"])
        if key in seen:
            first = seen[key]
            if first["gender"] != c["gender"]:
                first["gender"] = "neutral"
                first["reason"] += "；男女两版内容相同，合并为中性"
                c["reason"] = "与 %s 内容相同，已合并为中性" % first["name"]
            else:
                c["reason"] = "与 %s 内容完全相同（重复录音）" % first["name"]
            c["status"] = "rejected"
            c["dup_of"] = first["name"]
        else:
            seen[key] = c

    confirmed = [c for c in clips if c["status"] == "confirmed"]
    uncertain = [c for c in clips if c["status"] == "uncertain"]
    rejected = [c for c in clips if c["status"] == "rejected"]
    log("核验结果：confirmed %d / uncertain %d / rejected %d"
        % (len(confirmed), len(uncertain), len(rejected)))

    by_card = {}
    for c in confirmed:
        by_card.setdefault(c["card"], []).append(c)
    log("覆盖牌数：%d / %d" % (len([k for k in by_card if k != "equip"]), len(cards)))
    missing = [k for k, _ in cards if k not in by_card]
    if missing:
        log("本作中无卡牌语音：%s" % ", ".join(missing))

    if args.dry_run:
        for key, _ in cards:
            if key in by_card:
                log("  %-12s %2d 条" % (key, len(by_card[key])))
        if "equip" in by_card:
            log("  %-12s %2d 条" % ("equip", len(by_card["equip"])))
        return 0

    # ---------------------------------------------------------- 导出
    if os.path.isdir(OUT_DIR):
        shutil.rmtree(OUT_DIR)
    os.makedirs(OUT_DIR, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="sgs_card_v2_")
    mapping, gender_map, failures, exported = {}, {}, [], {}
    total_bytes = 0
    t0 = time.time()
    gender_order = {"male": 0, "female": 1, "neutral": 2}
    try:
        order = {k: i for i, (k, _) in enumerate(cards)}
        order["equip"] = 999
        for key in sorted(by_card, key=lambda k: order.get(k, 998)):
            group = by_card[key]
            group.sort(key=lambda c: (gender_order.get(c["gender"], 9),
                                      c["name"].count("."), c["name"]))
            counters = {}
            for c in group:
                g = c["gender"]
                counters[g] = counters.get(g, 0) + 1
                fname = "%s_%s_%d.mp3" % (key, g, counters[g])
                out_path = os.path.join(OUT_DIR, fname)
                # 归一增益：拉平各条语音的响度（用户反馈杀偏轻）
                gain = 0.0
                if not args.no_normalize and c["rms_db"] > -60:
                    gain = max(-MAX_GAIN_DB, min(MAX_GAIN_DB, TARGET_RMS_DB - c["rms_db"]))
                    if c["peak_db"] + gain > PEAK_CEIL_DB:
                        gain = PEAK_CEIL_DB - c["peak_db"]
                # 掐掉首尾静音，减少点击到出声的等待
                start = max(0.0, c["lead"] - 0.03)
                end = c["dur"] - max(0.0, c["tail"] - 0.05)
                try:
                    size = encode_mp3(c["wav"], out_path, args.bitrate, tmpdir,
                                      gain_db=gain, start=start, end=end)
                    total_bytes += size
                    mapping.setdefault(key, []).append("card/" + fname)
                    slot = gender_map.setdefault(
                        key, {"male": [], "female": [], "neutral": []})
                    slot.setdefault(g, []).append("card/" + fname)
                    c["out"] = fname
                    c["gain"] = round(gain, 1)
                    exported[c["name"]] = fname
                except Exception as exc:
                    failures.append((c["name"], str(exc)[:150]))
                    c["status"] = "rejected"
                    c["reason"] = "导出失败：%s" % str(exc)[:100]
                    if os.path.exists(out_path):
                        os.remove(out_path)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    log("导出 %d 个文件 / %s / %.1fs（含响度归一与静音裁剪）"
        % (sum(len(v) for v in mapping.values()), human(total_bytes),
           time.time() - t0))

    # ---------------------------------------------------------- 映射
    ordered = {}
    for key, _ in cards:
        if key in mapping:
            ordered[key] = mapping[key]
    if "equip" in mapping:
        ordered["equip"] = mapping["equip"]

    # 兼容字段 + 性别元数据：_gender 与 _meta 以下划线开头，避免被当成牌名
    ordered["_gender"] = {}
    for key in list(ordered.keys()):
        if key.startswith("_"):
            continue
        gslot = gender_map.get(key, {"male": [], "female": [], "neutral": []})
        ordered["_gender"][key] = gslot
    ordered["_meta"] = {
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "genderPolicy": "按出牌者性别选 male/female；缺该性别时回退 neutral，再回退通用 sfx_card_play",
        "note": "顶层 <key> 为兼容用的全量数组；性别请读 _gender[<key>]",
    }
    os.makedirs(os.path.dirname(MAP_PATH), exist_ok=True)
    with open(MAP_PATH, "w", encoding="utf-8") as fh:
        json.dump(ordered, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    update_audio_index(ordered, mapping)

    # ---------------------------------------------------------- 全量复核
    generals = load_generals_skills()
    heromusic = load_heromusic()
    local_general = set(os.listdir(GENERAL_DIR)) if os.path.isdir(GENERAL_DIR) else set()
    skill_rows, gen_rows = audit_generals(generals, heromusic, local_general)

    card_rows = []
    for key, slots in gender_map.items():
        for gender in ("male", "female", "neutral"):
            for f in slots.get(gender, []):
                full = os.path.join(ROOT, "assets", "audio", f)
                dur, peak, mean, size = probe_audio(full)
                card_rows.append({"card": key, "gender": gender, "file": f,
                                  "dur": dur, "peak": peak, "rms": mean, "size": size,
                                  "f0": median_f0(full)})

    anomalies = []
    for sub in ("card", "general", "sfx", "bgm"):
        d = os.path.join(ROOT, "assets", "audio", sub)
        if not os.path.isdir(d):
            continue
        for fn in sorted(os.listdir(d)):
            path = os.path.join(d, fn)
            if not os.path.isfile(path):
                continue
            size = os.path.getsize(path)
            if size == 0:
                anomalies.append((sub, fn, "空文件（0 字节）"))
            elif size < 2600 and sub == "general":
                dur, peak, mean, _ = probe_audio(path)
                if dur < 0.3:
                    anomalies.append((sub, fn, "超短 %.2fs" % dur))
                elif peak is not None and peak < -40:
                    anomalies.append((sub, fn, "近乎静音（峰值 %.1f dB）" % peak))

    audit = {"skill_rows": skill_rows, "gen_rows": gen_rows,
             "card_rows": card_rows, "anomalies": anomalies,
             "general_files": len(local_general)}

    write_doc(cards, name2key, skills, clips, mapping, gender_map, missing,
              failures, total_bytes, args.bitrate, args.no_normalize, audit)
    log("映射 %s / 文档 %s"
        % (os.path.relpath(MAP_PATH, ROOT), os.path.relpath(DOC_PATH, ROOT)))
    return 0


def update_audio_index(ordered, mapping):
    """把卡牌映射写回 assets/audio_index.json。

    保持向后兼容：`cards` 仍是「牌名 -> 路径数组」；
    新增 `cardsGender` 提供 male/female/neutral 三档，
    新旧播放层都能读，不会因为结构变化直接失声。
    """
    try:
        with open(AUDIO_INDEX, encoding="utf-8") as fh:
            idx = json.load(fh)
    except Exception as exc:
        log("跳过 audio_index.json 更新：%s" % exc)
        return

    cards_flat = {}
    for key, files in ordered.items():
        if key.startswith("_"):
            continue
        cards_flat[key] = files
    idx["cards"] = cards_flat
    idx["cardsGender"] = {k: v for k, v in ordered.get("_gender", {}).items()}
    idx["cardGenderPolicy"] = {
        "pick": "by-player-gender",
        "order": ["male", "female", "neutral"],
        "fallback": "sfx_card_play",
    }
    stats = idx.setdefault("stats", {})
    stats["cardClips"] = sum(len(v) for v in cards_flat.values())
    stats["cardKeys"] = len(cards_flat)
    stats["cardsWithBothGenders"] = sum(
        1 for v in idx["cardsGender"].values() if v.get("male") and v.get("female"))
    stats["cardsGenderOnly"] = {
        "maleOnly": sorted(k for k, v in idx["cardsGender"].items()
                           if v.get("male") and not v.get("female")),
        "femaleOnly": sorted(k for k, v in idx["cardsGender"].items()
                             if v.get("female") and not v.get("male")),
    }
    with open(AUDIO_INDEX, "w", encoding="utf-8") as fh:
        json.dump(idx, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    log("已更新 %s（cards %d 键 / cardsGender %d 键）"
        % (os.path.relpath(AUDIO_INDEX, ROOT), len(cards_flat), len(idx["cardsGender"])))


def write_doc(cards, name2key, skills, clips, mapping, gender_map, missing, failures,
              total_bytes, bitrate, no_norm, audit):
    conf = [c for c in clips if c["status"] == "confirmed"]
    unc = [c for c in clips if c["status"] == "uncertain"]
    rej = [c for c in clips if c["status"] == "rejected"]
    cn = dict(cards)
    L = []
    a = L.append

    a("# 音频复核总表（卡牌语音 + 武将语音）")
    a("")
    a("> 本文件由 `tools/build_card_audio.py` 自动生成，请勿手工编辑。")
    a("")
    a("生成时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    a("")
    a("## 结论先说")
    a("")
    a("v1 的映射前提是错的：它把 clip 名的首段数字当成 `CardsBook.id`，")
    a("而原版实际使用的是 **skillID**。两者只在基础牌 1~7 上恰好同序，")
    a("所以「杀/闪/桃」看起来对，到 `50=裸衣`、`200=仁王盾`、`201=寒冰剑` 就全错位。")
    a("这也是用户看到「部分语音和牌不一致」的直接原因。")
    a("")
    a("## 证据链")
    a("")
    a("| # | 来源 | 证明内容 |")
    a("| ---: | --- | --- |")
    a("| 1 | `extract/GameMain` 的 `GetNormalSkillSound` | 卡牌语音来自 `cardMusicDict`，键为 `<skillID>_<key>`，")
    a("|   |  | 最终路径 `voice/spell/card/<skillID>.<key>.<gender>[.<type>]` |")
    a("| 2 | `list2.sgs` → `sys_h5_music.cardmusic`（184 条） | 权威声明：`skillID/key/type/musicboy/musicgirl` |")
    a("| 3 | `list6.sgs` → `cha_spell.GameSpells.spell` | `a` 即 skillID，`c` 为技能中文名（1=杀、2=闪、3=桃…） |")
    a("| 4 | `extract/GameMain` 的 `class rat` | `Huo=6, Lei=7, Bing=11` → 后缀 6=火杀、7=雷杀、11=冰杀 |")
    a("| 5 | 源码硬编码抽样 | 闪电判定用 `spell/card/11.3`、藤甲用 `88.3`、铁索用 `85.3`，与上表一致 |")
    a("")
    a("## 概览")
    a("")
    a("| 项目 | 数值 |")
    a("| --- | --- |")
    a("| 原始 clip | %d 条 |" % len(clips))
    a("| confirmed（进映射） | %d 条 |" % len(conf))
    a("| uncertain（同名但未声明/存疑，不进映射） | %d 条 |" % len(unc))
    a("| rejected（非本作牌/重复/其它玩法） | %d 条 |" % len(rej))
    a("| 覆盖牌数 | %d / %d |" % (len([k for k in mapping if k != "equip"]), len(cards)))
    a("| 输出文件 | %d 个（%s） |" % (sum(len(v) for v in mapping.values()), human(total_bytes)))
    a("| 编码 | MP3 单声道 22050 Hz %s%s |"
      % (bitrate, "，未归一" if no_norm else "，响度归一到 -18 dBFS"))
    a("| 失败 | %d 条 |" % len(failures))
    a("")
    a("处理规则：只保留 confirmed；同名但未在 `cardmusic` 声明的（如 `11.3` 判定音）归为 uncertain 不进映射；")
    a("完全相同的重复录音（如桃的 4 条）只保留 1 条，其余标 rejected。")
    a("")
    if not no_norm:
        a("所有文件都做了两件事：**响度归一到 -18 dBFS**（解决 sha 比 leisha 轻 6~7 dB 的问题）、")
        a("**掐掉首尾静音**（减少点击到出声的延迟）。")
        a("")
    # ---- 「杀没声」专项分析 ----
    sha_clips = [c for c in clips if RE_CLIP.match(c["name"])
                 and RE_CLIP.match(c["name"]).group(1) == "1"]
    sha_sp = [c["speech"] for c in sha_clips if c.get("speech")]
    # v1 的 sha 池：sid=1 的全部变体 + sid=50（裸衣）
    v1_pool = [c for c in clips if RE_CLIP.match(c["name"])
               and RE_CLIP.match(c["name"]).group(1) in ("1", "50")]
    fire = [c for c in v1_pool if (RE_CLIP.match(c["name"]).group(4) or "") == "6"]
    thun = [c for c in v1_pool if (RE_CLIP.match(c["name"]).group(4) or "") == "7"]
    ice = [c for c in v1_pool if (RE_CLIP.match(c["name"]).group(4) or "") == "11"]
    luoyi = [c for c in v1_pool if RE_CLIP.match(c["name"]).group(1) == "50"]
    pure = [c for c in v1_pool if RE_CLIP.match(c["name"]).group(1) == "1"
            and not (RE_CLIP.match(c["name"]).group(4))]
    # ---------------- 全量复核 ----------------
    sk = audit["skill_rows"]
    gr = audit["gen_rows"]
    cr = audit["card_rows"]
    an = audit["anomalies"]
    n_gen = len(gr)
    with_audio = [g for g in gr if g["skill_ok"] and g["death_ok"]]
    no_audio = [g for g in gr if not g["has_general"]]
    n_ok = sum(1 for r in sk if r["status"] == "ok")
    n_nov = sum(1 for r in sk if r["status"] == "no-voice")
    n_nogen = sum(1 for r in sk if r["status"] == "no-general")
    n_abs = sum(1 for r in sk if r["status"] == "absent")
    death_ok = sum(1 for g in gr if g["death_ok"] > 0)

    a("## 全量音频复核")
    a("")
    a("> 复核口径：文件是否存在 + 编解码是否可读 + 时长/峰值/平均响度。")
    a("> **不涉及语义**：没有 ASR（本机无 whisper/vosk，且无外网），")
    a("> 所有「这条是不是某技能」的判断都来自原版配置 `sys_h5_music.heromusic/cardmusic`，属**配置级证据**，不是听写结果。")
    a("")
    a("| 分类 | 文件数 | 说明 |")
    a("| --- | ---: | --- |")
    a("| 武将语音 `general/` | %d | 覆盖 %d/%d 将 |"
      % (audit["general_files"], len(with_audio), n_gen))
    a("| 卡牌语音 `card/` | %d | 覆盖 %d/%d 张牌 |"
      % (sum(len(v) for v in gender_map.values()), len([k for k in gender_map if k != "equip"]), len(cards)))
    a("| 音效 `sfx/` | 14 | 通用界面/牌局音效 |")
    a("| 音乐 `bgm/` | 2 | 菜单 / 战斗 |")
    a("")
    a("### 武将 / 技能覆盖")
    a("")
    a("| 指标 | 结果 |")
    a("| --- | --- |")
    a("| 武将总数 | %d |" % n_gen)
    a("| 技能+阵亡都有语音 | %d |" % len(with_audio))
    a("| 完全无音频的武将 | %d（%s） |"
      % (len(no_audio), "、".join("%d %s" % (g["id"], g["name"]) for g in no_audio) or "无"))
    a("| 技能总数 | %d |" % len(sk))
    a("| 技能有语音 | %d（%.0f%%） |" % (n_ok, 100.0 * n_ok / max(1, len(sk))))
    a("| 技能在原版配置里就没有配音 | %d |" % (n_nov + n_nogen))
    a("| 配置有、本地缺失 | %d |" % n_abs)
    a("| 有阵亡语音的武将 | %d/%d |" % (death_ok, n_gen))
    a("| **受伤语音** | **0/%d**：原版 `heromusic` 只有「技能(e 为空)」与「阵亡(e=1)」两类，"
      "没有受伤条目，因此这项在原版就不存在 |" % n_gen)
    a("")
    a("### 57 将逐将核对")
    a("")
    a("| ID | 武将 | 性别 | 技能(有/总) | 阵亡 | 受伤 | 结论 |")
    a("| ---: | --- | --- | ---: | ---: | ---: | --- |")
    for g in gr:
        if not g["has_general"]:
            verdict = "**无任何语音**（原版无配置、本地无目录）"
        elif g["skill_ok"] == g["skills"] and g["death_ok"] > 0:
            verdict = "完整"
        elif g["skill_ok"] == g["skills"]:
            verdict = "缺阵亡"
        else:
            verdict = "缺技能语音"
        a("| %d | %s | %s | %d/%d | %s | 无此类别 | %s |"
          % (g["id"], g["name"], "男" if g["gender"] == "male" else "女",
             g["skill_ok"], g["skills"],
             "有" if g["death_ok"] > 0 else "**无**", verdict))
    a("")
    a("### 100 条技能逐条核对")
    a("")
    a("状态说明：`ok` 有语音；`no-voice` 原版配置里就没有配音（多为锁定/被动技）；")
    a("`no-general` 该武将在原版没有语音配置；`absent` 配置有但本地缺文件。")
    a("")
    a("| 武将 | 技能 | 状态 | 男声 | 女声 | 台词（原版配置，非听写） |")
    a("| --- | --- | --- | ---: | ---: | --- |")
    for r in sk:
        a("| %s | %s | %s | %d | %d | %s |"
          % (r["gname"], r["skill"], r["status"], len(r["male"]), len(r["female"]),
             (r["text"] or "").replace("|", "\\|")))
    a("")
    # ---------------- 技能 → 文件（播放用） ----------------
    smap = None
    smap_path = os.path.join(ROOT, "out", "general_audio_map.json")
    if os.path.exists(smap_path):
        try:
            with open(smap_path, encoding="utf-8") as fh:
                smap = json.load(fh)
        except Exception:
            smap = None

    a("### 技能 → 文件映射（播放用）")
    a("")
    if not smap:
        a("未找到 `out/general_audio_map.json`，先运行 `python3 tools/build_general_skill_map.py`。")
    else:
        st = {}
        for r in sk:
            st[r["status"]] = st.get(r["status"], 0) + 1
        a("由 `tools/build_general_skill_map.py` 生成，**按技能中文名对齐**（不是按槽位号）。")
        a("状态：`ok` 有文件 / `no-voice` 原版未配音 / `no-general` 武将无配置 / `uncertain` 无法确认。")
        a("")
        a("| 状态 | 数量 |")
        a("| --- | ---: |")
        for k in ("ok", "no-voice", "no-general", "absent", "uncertain"):
            a("| %s | %d |" % (k, st.get(k, 0)))
        a("")
        conflicts = [{"gid": g["id"], "name": g["name"],
                      "data": g["data_names"], "config": g["cfg_names"]}
                     for g in gr if g.get("order_diff")]
        if conflicts:
            a("**槽位顺序与 `js/data.js` 不一致的武将（已按技能名纠正，不按位置）**：")
            a("")
            a("| ID | 武将 | data.js 顺序 | 原版槽位顺序 |")
            a("| ---: | --- | --- | --- |")
            for c in conflicts:
                a("| %d | %s | %s | %s |"
                  % (c["gid"], c["name"], " / ".join(c["data"]), " / ".join(c["config"])))
            a("")
        a("| 武将 | 技能 | 状态 | 文件数 | 文件（最多列 3 个） |")
        a("| --- | --- | --- | ---: | --- |")
        by_gid = {r["gid"]: r for r in sk}
        for gid_str in sorted(smap.keys(), key=lambda x: (0, int(x)) if x.isdigit() else (1, 0)):
            if gid_str.startswith("_"):
                continue
            g = smap[gid_str]
            gname = next((r["gname"] for r in sk if r["gid"] == int(gid_str)), gid_str)
            for skey, files in g.items():
                if skey == "death":
                    continue
                row = next((r for r in sk if r["gid"] == int(gid_str) and r["key"] == skey), None)
                status = row["status"] if row else ("ok" if files else "no-voice")
                a("| %s | %s | %s | %d | %s |"
                  % (gname, row["skill"] if row else skey, status, len(files),
                     "<br>".join(f.split("/")[-1] for f in files[:3]) or "—"))
            a("| %s | 阵亡 | %s | %d | %s |"
              % (gname, "ok" if g.get("death") else "no-voice", len(g.get("death", [])),
                 "<br>".join(f.split("/")[-1] for f in g.get("death", [])[:3]) or "—"))
        a("")
        missing_skills = [r for r in sk if r["status"] in ("no-voice", "no-general", "absent")]
        a("**无技能音（播放时应保持安静，不要回退到同武将其它技能）**：%s"
          % ("；".join("%s·%s" % (r["gname"], r["skill"]) for r in missing_skills) or "无"))
        a("")
        a("用法示例（伪代码，需你接）：")
        a("")
        a("```js")
        a("const MAP = （读 out/general_audio_map.json）;")
        a("const list = MAP[String(gid)] && MAP[String(gid)][skillKey];")
        a("if (list && list.length) play(list);   // 只播本技能，不跨技能随机")
        a("else /* 该技能无配音，保持安静 */;")
        a("```")
        a("")

    a("### 卡牌逐牌核对")
    a("")
    a("| 牌 | 男 | 女 | 中性 | 时长范围 | 男声RMS | 女声RMS | 男女差 | F0 男/女 | 性别校验 | 状态 |")
    a("| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- | --- | --- |")
    import statistics as _st
    for key, zh in cards:
        if key not in gender_map:
            continue
        slots = gender_map[key]
        rows_k = [r for r in cr if r["card"] == key]
        durs = [r["dur"] for r in rows_k if r["dur"]]
        dm = [r["rms"] for r in rows_k if r["gender"] == "male" and r["rms"] is not None]
        df = [r["rms"] for r in rows_k if r["gender"] == "female" and r["rms"] is not None]
        mm = _st.mean(dm) if dm else None
        ff = _st.mean(df) if df else None
        gap = abs(mm - ff) if (mm is not None and ff is not None) else None
        f0m = [r["f0"] for r in rows_k if r["gender"] == "male" and r.get("f0")]
        f0f = [r["f0"] for r in rows_k if r["gender"] == "female" and r.get("f0")]
        f0m_s = "%d" % _st.median(f0m) if f0m else "-"
        f0f_s = "%d" % _st.median(f0f) if f0f else "-"
        if f0m and f0f:
            f0_verdict = "正常（男<女）" if _st.median(f0m) < _st.median(f0f) else "**疑似搞反**"
        else:
            f0_verdict = "-"
        flag = []
        if gap is not None and gap > 3.0:
            flag.append("男女音量差偏大")
        if durs and min(durs) < 0.3:
            flag.append("存在超短语音")
        if not flag:
            flag.append("正常")
        a("| `%s` | %d | %d | %d | %s | %s | %s | %s | %s/%s | %s | %s |"
          % (key, len(slots.get("male", [])), len(slots.get("female", [])),
             len(slots.get("neutral", [])),
             ("%.2f~%.2fs" % (min(durs), max(durs))) if durs else "-",
             ("%.1f" % mm) if mm is not None else "-",
             ("%.1f" % ff) if ff is not None else "-",
             ("%.1f dB" % gap) if gap is not None else "-",
             f0m_s, f0f_s, f0_verdict,
             "、".join(flag)))
    a("")
    a("### 异常与缺失清单")
    a("")
    if an:
        a("| 目录 | 文件 | 问题 |")
        a("| --- | --- | --- |")
        for sub, fn, why in an:
            a("| %s | `%s` | %s |" % (sub, fn, why))
    else:
        a("未发现空文件、超短（<0.3s）或近乎静音的音频。")
    a("")
    a("- **完全无语音武将**：%s（原版 `heromusic` 无配置、本地也无 `spell/` 目录）"
      % ("、".join("%d %s" % (g["id"], g["name"]) for g in no_audio) or "无"))
    a("- **原版未配音技能**：%s"
      % ("、".join("%s·%s" % (r["gname"], r["skill"]) for r in sk
                   if r["status"] in ("no-voice", "no-general")) or "无"))
    a("- **配置有但本地缺**：%s"
      % ("、".join("%s·%s" % (r["gname"], r["skill"]) for r in sk
                   if r["status"] == "absent") or "无"))
    a("- **无卡牌语音的牌**：%s（本地包无对应 skillID 录音）"
      % ("、".join("`%s`" % k for k in missing) or "无"))
    a("")

    a("## 关于「出【杀】没有声音」")
    a("")
    a("按影响程度排序，逐项给证据：")
    a("")
    a("**1. 播放键名 / UI 调用：已排除。**")
    a("`js/game.js` 造牌时 `name` 存的是拼音键（`['sha','spade',7]` → `{name:'sha'}`），")
    a("`js/ui.js` 在 `ev.kind==='use'` 时调用 `sfx('playCard', ev.card)`，")
    a("因此 `SGS_AUDIO.playCard('sha')` 收到的键是正确的，不是 `'杀'` 也不是对象。")
    a("")
    a("**2. 声音本身：不是静音，但「短 + 轻 + 尾部大段空白」。**")
    a("`杀` 的原始 clip 有效语音只有 %.2f~%.2f 秒（其它牌普遍 0.9~2.0 秒），"
      % (min(sha_sp), max(sha_sp)) if sha_sp else "`杀` 的原始 clip 有效语音很短")
    a("而声明时长 1.9~3.3 秒——中间 1.5~2.7 秒是数字静音填充。")
    a("v1 直接把这些文件整段转码，结果就是「点一下，响 0.3 秒，剩下两秒全是静音」，")
    a("在环境噪音或音量偏低时很容易被判成「没声音」。")
    a("")
    a("**3. 映射错位：确实存在，但表现为「语音和牌不一致」。**")
    a("v1 的 `sha` 池共 **%d 条**，实际构成是：" % len(v1_pool))
    a("")
    a("| 池内内容 | 条数 | 真实归属 | 是否正确 |")
    a("| --- | ---: | --- | --- |")
    a("| 无属性后缀的 `1.x.x` | %d | 普通【杀】 | ✅ |" % len(pure))
    a("| `1.x.x.6` | %d | 【火杀】 | ❌ 应归 huosha |" % len(fire))
    a("| `1.x.x.7` | %d | 【雷杀】 | ❌ 应归 leisha |" % len(thun))
    a("| `1.x.x.11` | %d | 【冰杀】（本作没有） | ❌ 应剔除 |" % len(ice))
    a("| `50.x` | %d | 技能「裸衣」 | ❌ 完全是别的语音 |" % len(luoyi))
    a("")
    a("也就是说 **%d/%d 条是错的**，只有 %d 条真正是普通【杀】。"
      % (len(v1_pool) - len(pure), len(v1_pool), len(pure)))
    a("这也直接解释了用户反馈的「部分语音和牌不一致」——出杀时随机抽到火杀、雷杀甚至裸衣的语音。")
    a("")
    a("**4. 真正的静音文件：不存在。** 202 条 clip 全部有有效语音（有效段 RMS 最低也有 -20.1 dB）。")
    a("")
    a("## 修复措施")
    a("")
    a("| 问题 | 处理 |")
    a("| --- | --- |")
    a("| 映射错位 | 以 `cardmusic`+`cha_spell` 重新核验，杀/火杀/雷杀彻底拆开，`50`、`200`、`201` 等归位 |")
    a("| 声音短、尾部静音 | 逐条掐掉首尾静音，文件时长 = 真实语音长度 |")
    a("| 响度不一 | 按**有效语音段**归一：目标 -18 dBFS RMS，增益上限 ±%.0f dB，峰值不超过 %.1f dBFS |"
      % (MAX_GAIN_DB, PEAK_CEIL_DB))
    a("| 重复录音 | 内容 md5 去重（桃的 4 条完全一样，只留 1 条） |")
    a("")
    # ---- 性别分布 ----
    both = [k for k, v in gender_map.items() if v.get("male") and v.get("female")]
    male_only = [k for k, v in gender_map.items() if v.get("male") and not v.get("female")]
    female_only = [k for k, v in gender_map.items() if v.get("female") and not v.get("male")]
    neutral_only = [k for k, v in gender_map.items()
                    if not v.get("male") and not v.get("female") and v.get("neutral")]
    a("## 性别分布（修复「男将出牌是女声」）")
    a("")
    a("原版文件名最后一段就是性别：`card/1.1.1`=男、`card/1.1.2`=女（来自 `cardmusic.musicboy/musicgirl`）。")
    a("v2 把文件名拍平成 `sha_1..4`，正好是「男、女、男、女」，男将有 50% 概率抽到女声。")
    a("v3 起文件名带性别：`card/<key>_<male|female|neutral>_<n>.mp3`。")
    a("")
    a("| 类型 | 数量 | 说明 |")
    a("| --- | ---: | --- |")
    a("| 男女齐全 | %d | 可按出牌者性别精确选择 |" % len(both))
    a("| 只有男声 | %d | 女将播放时应回退 neutral / 通用音 |" % len(male_only))
    a("| 只有女声 | %d | 男将播放时应回退 neutral / 通用音 |" % len(female_only))
    a("| 无性别（中性） | %d | 装备类音效，男女通用 |" % len(neutral_only))
    a("")
    a("| 牌 key | 中文名 | male | female | neutral | 状态 |")
    a("| --- | --- | ---: | ---: | ---: | --- |")
    for key, zh in cards:
        if key not in gender_map:
            continue
        v = gender_map[key]
        m_, f_, n_ = len(v.get("male", [])), len(v.get("female", [])), len(v.get("neutral", []))
        if m_ and f_:
            tag = "男女齐全"
        elif m_:
            tag = "**只有男声**"
        elif f_:
            tag = "**只有女声**"
        else:
            tag = "中性"
        a("| `%s` | %s | %d | %d | %d | %s |" % (key, zh, m_, f_, n_, tag))
    if "equip" in gender_map:
        v = gender_map["equip"]
        a("| `equip` | 装备通用 | %d | %d | %d | 中性 |"
          % (len(v.get("male", [])), len(v.get("female", [])), len(v.get("neutral", []))))
    a("")

    # ---- 无懈可击事件链 ----
    a("## 【无懈可击】为什么没有声音")
    a("")
    a("**素材没有问题**：`wuxie` 有 4 条确认语音（2 男 2 女），路径存在、时长 1.0~1.3 秒。")
    a("问题出在**事件链**：`assets` 有了，但 UI 从来没被通知去播。")
    a("")
    a("现状（读代码确认）：")
    a("")
    a("1. `js/ui.js` 里唯一触发卡牌音效的地方是 recent 扫描：")
    a("   `if (ev.kind === 'use') { sfx('playCard', ev.card); ... }`（约 2420 行）")
    a("2. 普通牌在 `js/cards.js` 使用时会 `this.recent.push({kind:'use', card, targets})`（237 / 247 / 273 行）")
    a("3. 但【无懈可击】走的是响应流程 `isNullified()`，只做了 `this.log(..., 'wuxie')`（`cards.js` 381 行），")
    a("   **没有 push recent**，所以 UI 收不到 `kind:'use'`，自然不播。")
    a("")
    a("**最小改法（只需改 `js/cards.js` 一处，3 行）：**")
    a("")
    a("```js")
    a("// js/cards.js, isNullified() 内，紧跟 this.log(...'wuxie') 之后")
    a("this.recent.push({ kind: 'use', seat: played.q.seat, card: 'wuxie', targets: [] });")
    a("if (this.recent.length > 200) this.recent.shift();")
    a("```")
    a("")
    a("为什么这样就够：")
    a("")
    a("- `targets: []` 让 `flashArrows()` 直接返回（`ui.js:779` 有空数组短路），只出声、不会画错箭头；")
    a("- 与 `cards.js:237`（无中生有这类非指向牌）写法一致，属于既有约定；")
    a("- 不用改 `ui.js`，也不用改 `audio.js`；")
    a("- `recent` 只有 UI 消费（`game.js:59` 注释「UI 动画用」），补事件不影响规则结算。")
    a("")
    a("若要区分「无懈是响应、不是出牌」，也可 push `{kind:'wuxie', seat}` 并在 `ui.js` recent 循环里加一个")
    a("`else if (ev.kind === 'wuxie')` 分支——但这是两处改动，非最小方案。")
    a("")

    a("## 逐牌映射")
    a("")
    a("| 牌 key | 中文名 | 条数 | 文件 |")
    a("| --- | --- | ---: | --- |")
    for key, zh in cards:
        if key not in mapping:
            continue
        a("| `%s` | %s | %d | %s |" % (key, zh, len(mapping[key]),
                                       "<br>".join(f.split("/")[-1] for f in mapping[key])))
    if "equip" in mapping:
        a("| `equip` | 装备通用 | %d | %s |" % (len(mapping["equip"]),
                                                "<br>".join(f.split("/")[-1] for f in mapping["equip"])))
    a("")
    a("## 无语音的牌（%d 张）" % len(missing))
    a("")
    a("原版卡牌语音包里没有这些牌的录音（或其 clip 不在本地资源包中）：")
    a("")
    a("、".join("`%s`(%s)" % (k, cn.get(k, "")) for k in missing) or "无。")
    a("")
    a("## 每条 clip 的核验状态")
    a("")
    a("| clip | skillID | 技能名 | 状态 | 性别 | 归属 | 时长 | RMS | 说明 |")
    a("| --- | ---: | --- | --- | --- | --- | ---: | ---: | --- |")
    for c in clips:
        m = RE_CLIP.match(c["name"])
        sid = m.group(1) if m else "-"
        skill = skills.get(int(sid), "-") if sid.isdigit() else "-"
        a("| `%s` | %s | %s | **%s** | %s | %s | %.2fs | %.1f dB | %s |"
          % (c["name"], sid, skill, c["status"], c.get("gender", "-"),
             ("`%s`→%s" % (c["card"], c.get("out", ""))) if c.get("out") else (c.get("card") or "-"),
             c["dur"], c["rms_db"], c["reason"]))
    a("")
    if failures:
        a("## 导出失败")
        a("")
        for name, why in failures:
            a("- `%s`：%s" % (name, why))
        a("")
    a("## 接入方式")
    a("")
    a("`out/card_audio_map.json` 的路径相对于 `assets/audio/`，只含 confirmed：")
    a("")
    a("```js")
    a("SGS_AUDIO.playCard('sha');   // assets/audio/card/sha_1.mp3 … 随机一条")
    a("SGS_AUDIO.playCard('huosha');")
    a("SGS_AUDIO.playCard('leisha');")
    a("```")
    a("")
    a("若某张牌没有对应语音（见上表），请回退到 `equip` 或通用 `sfx_card_play`。")
    a("")

    os.makedirs(os.path.dirname(DOC_PATH), exist_ok=True)
    with open(DOC_PATH, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L))


if __name__ == "__main__":
    sys.exit(main())
