#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""三国杀·单机版 — 音频抽取工具

从只读原始素材包（assets/Bundles/*.ab）中抽取游戏实际会用到的一小部分音频：

  * 武将语音：Assets/Res/LocalSoundCDN/spell/<id><拼音>/<皮肤>skill<N>_<变体>.ogg
             Assets/Res/LocalSoundCDN/spell/<id><拼音>/<皮肤>dead<N>.ogg
  * 界面音效：按钮、发牌、判定翻牌、掉血、开战、结束、胜负结算
  * 背景音乐：backgroundmusic01/02（可选）

导出链路：UnityPy 读 AudioClip → fmod/pyfmodex 解码 FSB5 得到 WAV →
ffmpeg(libmp3lame) 压缩为 MP3 → 写入 assets/audio/，同时生成 assets/audio_index.json。

用法：
    python3 tools/extract_audio.py            # 正常抽取
    python3 tools/extract_audio.py --dry-run  # 只统计将要抽取的内容，不落盘
    python3 tools/extract_audio.py --with-bgm # 额外导出两条 BGM
    python3 tools/extract_audio.py --force    # 覆盖已存在文件

素材包只读，本脚本不会修改 assets/Bundles/ 下任何文件。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

# ---------------------------------------------------------------- 路径配置
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# 原始素材包（只读）。优先用环境变量 SGS_AB_DIR 指定，其次用打包时的默认位置。
DEFAULT_BUNDLES = ("/Users/chenlei/WorkBuddy/2026-10-26-13-50-39/"
                   "sgs_offline/assets/Bundles")
BUNDLES = os.environ.get("SGS_AB_DIR") or DEFAULT_BUNDLES
if not os.path.isdir(BUNDLES):
    _local = os.path.join(ROOT, "assets", "Bundles")
    if os.path.isdir(_local):
        BUNDLES = _local
OUT_AUDIO = os.path.join(ROOT, "assets", "audio")
INDEX_PATH = os.path.join(ROOT, "assets", "audio_index.json")
DATA_JS = os.path.join(ROOT, "js", "data.js")

VOICE_BITRATE = "64k"
SFX_BITRATE = "64k"
BGM_BITRATE = "96k"

# 卡片名兜底表（与 js/data.js 的 pinyin 对齐；解析失败时使用）
FALLBACK_CARDS = [
    "sha", "huosha", "leisha", "shan", "tao", "jiu",
    "juedou", "guohe", "shunshou", "wuzhong", "jiedao", "nanman", "wanjian",
    "taoyuan", "wugu", "wuxie", "huogong", "tiesuo",
    "lebu", "shandian", "bingliang",
    "zhugeliannu", "qinggang", "cixiong", "qinglong", "zhangba", "guanshi",
    "fangtian", "qilin", "hanbing", "gudingdao", "zhuque", "bagua", "renwang",
    "tengjia", "baiyinshizi", "chitu", "dawan", "zixing", "dilu", "jueying",
    "zhuahuang", "hualiu",
]

# 攻击类【杀】：用"挥砍"音效，其余牌统一用"出牌"音效
SLASH_CARDS = {"sha", "huosha", "leisha"}

# 音效白名单：输出名 -> 素材包内原始路径
SFX_MAP = [
    # key               输出文件                    原始资源路径
    ("click",           "sfx_click.mp3",             "assets/res/sound/button/button1.ogg"),
    ("back",            "sfx_back.mp3",              "assets/res/sound/button/backa.ogg"),
    ("card_play",       "sfx_card_play.mp3",         "assets/res/sound/opencard/opencard_down1.ogg"),
    ("card_draw",       "sfx_card_draw.mp3",         "assets/res/sound/opencard/opencard_mainputong.ogg"),
    ("card_flip",       "sfx_card_flip.mp3",         "assets/res/sound/ui_fanpai1.ogg"),
    ("slash",           "sfx_slash.mp3",             "assets/res/sound/paijvbaodian/kill_1.ogg"),
    ("kill",            "sfx_kill.mp3",              "assets/res/sound/paijvbaodian/kill_2.ogg"),
    ("damage",          "sfx_damage.mp3",            "assets/res/sound/diaoxue.ogg"),
    ("armor",           "sfx_armor.mp3",             "assets/res/sound/armor1.ogg"),
    ("game_start",      "sfx_game_start.mp3",        "assets/res/sound/kaizhan.ogg"),
    ("turn_end",        "sfx_turn_end.mp3",          "assets/res/sound/jieshu.ogg"),
    ("win",             "sfx_win.mp3",               "assets/res/sound/ui_zhandoushengli.ogg"),
    ("lose",            "sfx_lose.mp3",              "assets/res/sound/ui_zhandoushibai.ogg"),
    ("draw",            "sfx_draw.mp3",              "assets/res/sound/ui_zhandoupingju.ogg"),
]

BGM_MAP = [
    ("menu",   "bgm_menu.mp3",   "assets/res/sound/bgm/backgroundmusic01.ogg"),
    ("battle", "bgm_battle.mp3", "assets/res/sound/bgm/backgroundmusic02.ogg"),
]

RE_SPELL = re.compile(r"assets/res/localsoundcdn/spell/(\d+)([a-z0-9_]*)/([^/]+)\.ogg$")
RE_SKIN_FILE = re.compile(r"^(\d+)(skill(\d+)_(\d+)|dead(\d+))$")
RE_CARD_PINYIN = re.compile(r"pinyin:\s*'([a-z]+)'")
RE_GENERAL = re.compile(r"G\((\d+),\s*'([^']+)'")


# ---------------------------------------------------------------- 工具函数
def human(nbytes):
    for unit in ("B", "KB", "MB", "GB"):
        if nbytes < 1024 or unit == "GB":
            return "%.1f %s" % (nbytes, unit) if unit != "B" else "%d B" % nbytes
        nbytes /= 1024.0
    return "%.1f GB" % nbytes


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def read_game_names():
    """从 js/data.js 解析牌名拼音与武将 id->中文名，解析失败时静默回退。"""
    cards, generals = [], {}
    try:
        with open(DATA_JS, encoding="utf-8") as fh:
            src = fh.read()
        cards = RE_CARD_PINYIN.findall(src)
        for gid, gname in RE_GENERAL.findall(src):
            generals[int(gid)] = gname
    except OSError:
        pass
    if not cards:
        cards = list(FALLBACK_CARDS)
    # 去重且保持顺序
    seen, uniq = set(), []
    for c in cards:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq, generals


def build_path_index():
    """扫描 sound 相关 bundle，建立 {资源路径小写: bundle 文件名}。"""
    if not os.path.isdir(BUNDLES):
        sys.exit("找不到素材包目录：%s" % BUNDLES)
    try:
        import UnityPy
    except ImportError:
        sys.exit("缺少 UnityPy，请用素材包自带的 venv 运行本脚本。")

    files = [f for f in os.listdir(BUNDLES)
             if f.endswith(".ab") and "sound" in f.lower()]
    index, errors = {}, []
    t0 = time.time()
    for name in files:
        path = os.path.join(BUNDLES, name)
        try:
            env = UnityPy.load(path)
            for bundle_file in env.files.values():
                for asset_path in (getattr(bundle_file, "container", None) or {}):
                    index[asset_path.lower()] = name
        except Exception as exc:  # 单个包损坏不影响整体
            errors.append((name, "%s: %s" % (type(exc).__name__, str(exc)[:120])))
    log("索引 %d 个音频资源 / 扫描 %d 个 bundle / 用时 %.1fs"
        % (len(index), len(files), time.time() - t0))
    if errors:
        log("  解析失败的 bundle：%d 个（已跳过）" % len(errors))
    return index, errors


def discover_general_voices(path_index):
    """返回 {general_id: {"dir": 目录名, "skill": [...], "death": [...]}}。"""
    dirs = {}
    for asset_path in path_index:
        m = RE_SPELL.match(asset_path)
        if not m:
            continue  # spell/card 下的数字命名音频无法可靠映射，跳过
        gid, suffix, fname = int(m.group(1)), m.group(2), m.group(3)
        if not (1 <= gid <= 57):
            continue
        # 只接受"id + 纯拼音"的目录，排除 108spzhaoyun / 299jieliubei 等变体皮肤
        if not suffix or not suffix.isalpha():
            continue
        dirs.setdefault(gid, {}).setdefault(suffix, []).append(fname)

    result = {}
    for gid, by_dir in dirs.items():
        # 同名 id 有多个目录时取最短的（基础版优先于 jie/sp/mou 变体）
        suffix = sorted(by_dir, key=lambda s: (len(s), s))[0]
        files = by_dir[suffix]
        groups = {}
        for fname in files:
            m = RE_SKIN_FILE.match(fname)
            if not m:
                continue
            skin = int(m.group(1))
            if m.group(5) is not None:  # 形如 1dead01
                groups.setdefault(skin, []).append(("death", 0, int(m.group(5)), fname))
            else:                        # 形如 1skill2_1
                groups.setdefault(skin, []).append(
                    ("skill", int(m.group(3)), int(m.group(4)), fname))
        if not groups:
            continue
        skin = min(groups)  # 默认皮肤
        skills, deaths = {}, {}
        for kind, slot, variant, fname in groups[skin]:
            bucket = skills if kind == "skill" else deaths
            key = slot if kind == "skill" else variant
            if key not in bucket or variant < bucket[key][0]:
                bucket[key] = (variant, fname)
        result[gid] = {
            "dir": "%d%s" % (gid, suffix),
            "skill": [v[1] for _, v in sorted(skills.items())],
            "death": [v[1] for _, v in sorted(deaths.items())],
        }
    return result


def ffmpeg_available():
    return shutil.which("ffmpeg") is not None


def encode_mp3(wav_bytes, out_path, bitrate, tmpdir):
    """WAV 字节 -> MP3 文件。返回输出字节数。"""
    src = os.path.join(tmpdir, "in.wav")
    with open(src, "wb") as fh:
        fh.write(wav_bytes)
    cmd = [
        "ffmpeg", "-v", "error", "-y", "-i", src,
        "-codec:a", "libmp3lame", "-b:a", bitrate,
        "-ar", "22050", "-ac", "1", out_path,
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg 编码失败: %s" % proc.stderr.decode("utf-8", "replace")[:200])
    return os.path.getsize(out_path)


def main():
    parser = argparse.ArgumentParser(description="从原始素材包抽取游戏音频")
    parser.add_argument("--dry-run", action="store_true", help="只统计，不写文件")
    parser.add_argument("--with-bgm", action="store_true", help="额外导出背景音乐")
    parser.add_argument("--force", action="store_true", help="覆盖已存在文件")
    parser.add_argument("--budget-mb", type=float, default=60.0, help="音频总体积预算(MB)")
    args = parser.parse_args()

    try:
        import UnityPy  # noqa: F401
    except ImportError:
        sys.exit("缺少 UnityPy：请使用 %s/.venv/bin/python 运行"
                 % os.path.dirname(os.path.dirname(ROOT)))

    use_mp3 = ffmpeg_available()
    if not use_mp3:
        log("未找到 ffmpeg，将导出 WAV（体积更大）")
    ext = ".mp3" if use_mp3 else ".wav"

    cards, general_names = read_game_names()
    log("游戏内牌名 %d 个 / 武将 %d 名" % (len(cards), len(general_names)))

    path_index, scan_errors = build_path_index()
    voices = discover_general_voices(path_index)
    log("可抽取武将语音：%d 名（应有 57 名）" % len(voices))
    missing = [i for i in range(1, 58) if i not in voices]
    if missing:
        log("  无语音武将 id：%s" % ", ".join(str(i) for i in missing))

    # ------------------------------------------------------------ 组装任务
    tasks = []  # (输出相对路径, 原始资源路径, 码率, 分组, 元信息)
    for gid in sorted(voices):
        info = voices[gid]
        for i, fname in enumerate(info["skill"]):
            src = "assets/res/localsoundcdn/spell/%s/%s.ogg" % (info["dir"], fname)
            tasks.append(("general/general_%03d_skill%d%s" % (gid, i + 1, ext),
                          src, VOICE_BITRATE, "general", (gid, "skill")))
        for i, fname in enumerate(info["death"]):
            src = "assets/res/localsoundcdn/spell/%s/%s.ogg" % (info["dir"], fname)
            tasks.append(("general/general_%03d_death%d%s" % (gid, i + 1, ext),
                          src, VOICE_BITRATE, "general", (gid, "death")))

    for key, out_name, src in SFX_MAP:
        tasks.append(("sfx/%s" % out_name.replace(".mp3", ext), src,
                      SFX_BITRATE, "sfx", key))
    if args.with_bgm:
        for key, out_name, src in BGM_MAP:
            tasks.append(("bgm/%s" % out_name.replace(".mp3", ext), src,
                          BGM_BITRATE, "bgm", key))

    # 校验资源是否存在
    ready, problems = [], []
    for task in tasks:
        out_rel, src, bitrate, group, meta = task
        if src.lower() not in path_index:
            problems.append((src, "素材包内不存在该资源"))
            continue
        ready.append(task)

    log("待处理 %d 条音频（缺失 %d 条）" % (len(ready), len(problems)))
    if args.dry_run:
        by_group = {}
        for _, _, _, group, _ in ready:
            by_group[group] = by_group.get(group, 0) + 1
        log("  " + " / ".join("%s=%d" % kv for kv in sorted(by_group.items())))
        for src, why in problems[:10]:
            log("  [缺失] %s (%s)" % (src, why))
        return 0

    # ------------------------------------------------------------ 解码落盘
    by_bundle = {}
    for task in ready:
        by_bundle.setdefault(path_index[task[1].lower()], []).append(task)

    if not args.force and os.path.isdir(OUT_AUDIO):
        shutil.rmtree(OUT_AUDIO)  # 输出目录完全由本脚本生成，重建保证一致
    os.makedirs(OUT_AUDIO, exist_ok=True)

    tmpdir = tempfile.mkdtemp(prefix="sgs_audio_")
    written = []   # (out_rel, bytes)
    failures = list(problems)
    t0 = time.time()
    done = 0

    try:
        for bundle_name, bundle_tasks in sorted(by_bundle.items()):
            bundle_path = os.path.join(BUNDLES, bundle_name)
            try:
                env = UnityPy.load(bundle_path)
            except Exception as exc:
                for task in bundle_tasks:
                    failures.append((task[1], "bundle 载入失败: %s" % exc))
                continue
            clip_by_path = {}
            for obj in env.objects:
                if obj.type.name != "AudioClip":
                    continue
                container = (obj.container or "").lower()
                if container:
                    clip_by_path[container] = obj

            for out_rel, src, bitrate, group, meta in bundle_tasks:
                out_path = os.path.join(OUT_AUDIO, out_rel)
                os.makedirs(os.path.dirname(out_path), exist_ok=True)
                obj = clip_by_path.get(src.lower())
                if obj is None:
                    failures.append((src, "bundle 内找不到对应 AudioClip"))
                    continue
                try:
                    clip = obj.read()
                    # 语音素材的健全性检查：个别 AudioClip 是长段数字静音的占位/损坏资源，
                    # 直接跳过，避免打进包里白占体积（详见 README 的"已知限制"）。
                    length = float(getattr(clip, "m_Length", 0) or 0)
                    if length <= 0.05:
                        failures.append((src, "时长为 0，跳过"))
                        continue
                    if group == "general" and length > 20.0:
                        failures.append((src, "时长 %.1fs 异常（疑似占位/损坏音频），跳过"
                                         % length))
                        continue
                    samples = clip.samples  # FSB5 -> WAV 解码
                    if not samples:
                        raise RuntimeError("解码结果为空")
                    wav_bytes = list(samples.values())[0]
                    if use_mp3:
                        size = encode_mp3(wav_bytes, out_path, bitrate, tmpdir)
                    else:
                        with open(out_path, "wb") as fh:
                            fh.write(wav_bytes)
                        size = os.path.getsize(out_path)
                    written.append((out_rel, size))
                    done += 1
                    if done % 40 == 0:
                        log("  已导出 %d/%d ..." % (done, len(ready)))
                except Exception as exc:
                    failures.append((src, "%s: %s" % (type(exc).__name__, str(exc)[:150])))
                    if os.path.exists(out_path):
                        os.remove(out_path)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    elapsed = time.time() - t0
    total = sum(b for _, b in written)
    log("导出完成：%d 条，合计 %s，用时 %.1fs"
        % (len(written), human(total), elapsed))
    if failures:
        log("失败 %d 条（详见 audio_index.json 的 failures）" % len(failures))

    # ------------------------------------------------------------ 生成索引
    def rel(p):
        return p.replace(os.sep, "/")

    index = {
        "version": 1,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "format": "mp3" if use_mp3 else "wav",
        "root": "assets/audio/",
        "base": "assets/audio/",
        "cards": {},
        "cardFallback": None,
        "generals": {},
        "sfx": {},
        "bgm": {},
        "missingGenerals": missing,
        "failures": [{"source": s, "reason": r} for s, r in failures[:60]],
        "stats": {"clips": len(written), "bytes": total},
    }

    written_map = dict(written)
    # 素材包内没有可辨识的"杀/闪/桃"牌名语音（spell/card 下全为数字命名，无法可靠映射），
    # 因此牌面统一复用两条通用音效：出牌声 + 挥砍声。索引里写实际落盘路径。
    slash_rel = rel("sfx/%s" % dict((k, o) for k, o, _ in SFX_MAP)["slash"].replace(".mp3", ext))
    play_rel = rel("sfx/%s" % dict((k, o) for k, o, _ in SFX_MAP)["card_play"].replace(".mp3", ext))
    for card in cards:
        target = slash_rel if card in SLASH_CARDS else play_rel
        if target in written_map:
            index["cards"][card] = [target]
    index["cardFallback"] = play_rel if play_rel in written_map else None

    for gid, info in sorted(voices.items()):
        skills = [rel("general/general_%03d_skill%d%s" % (gid, i + 1, ext))
                  for i in range(len(info["skill"]))]
        deaths = [rel("general/general_%03d_death%d%s" % (gid, i + 1, ext))
                  for i in range(len(info["death"]))]
        skills = [p for p in skills if p in written_map]
        deaths = [p for p in deaths if p in written_map]
        if not skills and not deaths:
            continue
        index["generals"][str(gid)] = {
            "name": general_names.get(gid, ""),
            "skill": skills,
            "death": deaths,
        }

    for key, out_name, _src in SFX_MAP:
        p = rel("sfx/%s" % out_name.replace(".mp3", ext))
        if p in written_map:
            index["sfx"][key] = p
    for key, out_name, _src in BGM_MAP:
        p = rel("bgm/%s" % out_name.replace(".mp3", ext))
        if p in written_map:
            index["bgm"][key] = p

    with open(INDEX_PATH, "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=2, sort_keys=False)
        fh.write("\n")
    log("索引已写入 %s" % os.path.relpath(INDEX_PATH, ROOT))

    # ------------------------------------------------------------ 体积校验
    budget = args.budget_mb * 1024 * 1024
    if total > budget:
        log("警告：音频总体积 %s 超出预算 %.0f MB" % (human(total), args.budget_mb))
    else:
        log("音频总体积 %s，预算 %.0f MB，余量 %s"
            % (human(total), args.budget_mb, human(budget - total)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
