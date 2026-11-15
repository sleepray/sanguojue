#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""三国杀·单机版 — 原版武将语音全量抽取

遍历原版资源包中所有 `Assets/Res/LocalSoundCDN/spell/<id><拼音>/` 语音包，
把 1~57 号武将的**全部**语音（含各皮肤、各技能、各阵亡变体）导出为

    assets/audio/general/general_<三位ID>_<clipName>.mp3

clip 名本身带皮肤号与技能序号，例如 `1skill1_1` / `3dead01`，因此
`general_001_1skill1_1.mp3` 与既有 `general_001_skill1.mp3` 不会重名。
**已存在的同名文件一律跳过，不覆盖。**

用法：
    python3 tools/build_general_audio.py
    python3 tools/build_general_audio.py --dry-run
    python3 tools/build_general_audio.py --bitrate 48k
    python3 tools/build_general_audio.py --force      # 明确要求时才覆盖

产物：
    assets/audio/general/*.mp3（新增）
    out/general_audio_map.json
    docs/武将语音映射.md
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

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_SRC = "/Users/chenlei/WorkBuddy/2026-10-26-13-50-39/sgs_offline"
SRC_ROOT = os.environ.get("SGS_SRC") or DEFAULT_SRC
BUNDLES = os.path.join(SRC_ROOT, "assets", "Bundles")
DATA_JS = os.path.join(ROOT, "js", "data.js")
AUDIO_INDEX = os.path.join(ROOT, "assets", "audio_index.json")

OUT_DIR = os.path.join(ROOT, "assets", "audio", "general")
MAP_PATH = os.path.join(ROOT, "out", "general_audio_map.json")
DOC_PATH = os.path.join(ROOT, "docs", "武将语音映射.md")

# 1~57 号武将的目录拼音（用于核对 id 与名字是否自洽）
EXPECTED_PINYIN = {
    1: "liubei", 2: "guanyu", 3: "zhangfei", 4: "zhugeliang", 5: "zhaoyun",
    6: "machao", 7: "huangyueying", 8: "sunquan", 9: "ganning", 10: "lvmeng",
    11: "huanggai", 12: "zhouyu", 13: "daqiao", 14: "luxun", 15: "caocao",
    16: "simayi", 17: "xiahoudun", 18: "zhangliao", 19: "xuzhu", 20: "guojia",
    21: "zhenji", 22: "huatuo", 23: "lvbu", 24: "diaochan", 25: "sunshangxiang",
    26: "huangzhong", 27: "weiyan", 28: "xiahouyuan", 29: "caoren", 30: "xiaoqiao",
    31: "zhoutai", 32: "zhangjiao", 33: "yuji", 34: "dianwei", 35: "xunyu",
    36: "pangtong", 37: "wolongzhugeliang", 38: "taishici", 39: "pangde",
    40: "yanliangwenchou", 41: "yuanshao", 42: "xuhuang", 43: "caopi",
    44: "sunjian", 45: "dongzhuo", 46: "zhurong", 47: "menghuo", 48: "jiaxu",
    49: "lusu", 50: "zhanghe", 51: "dengai", 52: "jiangwei", 53: "liushan",
    54: "sunce", 55: "zhangzhaozhanghong", 56: "zuoci", 57: "caiwenji",
}

RE_GENERAL = re.compile(r"G\((\d+),\s*'([^']+)'")
RE_FOLDER = re.compile(r"^(\d+)([a-z].*)$")
# 兼容三种命名：NskillK_V、NdeadM、NdedaM（原版拼写错误），以及带 "~1" 重复标记的变体
RE_CLIP = re.compile(r"^(\d+)(skill(\d+)_(\d+)|dead(\d+)|deda(\d+))(~(\d+))?$")
# 原版素材包里两个确认损坏的阵亡语音（109.2 秒数字静音），任何一次运行都会跳过
KNOWN_BAD = {
    (4, "1dead01"): "时长 109.2s 且为数字静音，判定为占位/损坏音频",
    (6, "1dead01"): "时长 109.2s 且为数字静音，判定为占位/损坏音频",
}

RE_SPELL_PATH = re.compile(r"assets/res/localsoundcdn/spell/([^/]+)/", re.I)


def human(n):
    return "%.2f MB" % (n / 1048576.0) if n >= 1048576 else "%.1f KB" % (n / 1024.0)


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def ffmpeg_bin():
    return shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"


def load_generals():
    with open(DATA_JS, encoding="utf-8") as fh:
        src = fh.read()
    pairs = [(int(gid), name) for gid, name in RE_GENERAL.findall(src)]
    if not pairs:
        sys.exit("无法从 js/data.js 解析出 GENERALS")
    return dict(pairs)


def natural_key(name):
    return [(0, int(p)) if p.isdigit() else (1, p) for p in name.split(".")]


def wav_peak(wav_bytes):
    try:
        import array
        pos = wav_bytes.find(b"data")
        if pos < 0:
            return None
        data = wav_bytes[pos + 8:]
        if len(data) < 4:
            return None
        arr = array.array("h")
        arr.frombytes(data[:len(data) - (len(data) % 2)])
        if not arr:
            return None
        return max(max(arr), -min(arr))
    except Exception:
        return None


def encode_mp3(wav_bytes, out_path, bitrate, tmpdir):
    src = os.path.join(tmpdir, "in.wav")
    with open(src, "wb") as fh:
        fh.write(wav_bytes)
    cmd = [ffmpeg_bin(), "-v", "error", "-y", "-i", src,
           "-codec:a", "libmp3lame", "-b:a", bitrate,
           "-ar", "22050", "-ac", "1", out_path]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg 失败: %s" % proc.stderr.decode("utf-8", "replace")[:160])
    return os.path.getsize(out_path)


def load_legacy_index():
    """读取既有 audio_index.json，用于对比"已有/新增"。"""
    try:
        with open(AUDIO_INDEX, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def main():
    ap = argparse.ArgumentParser(description="导出原版武将语音")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--bitrate", default="48k", help="MP3 码率，默认 48k")
    ap.add_argument("--force", action="store_true", help="覆盖已存在的同名文件")
    ap.add_argument("--doc-only", action="store_true",
                    help="不重新编码，仅按目录现有文件重建 map 与文档")
    args = ap.parse_args()

    try:
        import UnityPy
    except ImportError:
        sys.exit("缺少 UnityPy：请用原版素材包的 .venv/bin/python 运行")

    generals = load_generals()
    legacy = load_legacy_index()
    legacy_generals = legacy.get("generals", {})
    log("我方武将 %d 名 / 既有 audio_index 收录 %d 名"
        % (len(generals), len(legacy_generals)))

    # ---------------------------------------------------------- 扫描资源包
    bundles = sorted(
        os.path.join(BUNDLES, f) for f in os.listdir(BUNDLES)
        if f.startswith("assets_res_localsoundcdn_spell_") and f.endswith(".ab")
        and "_card_" not in f)
    if not bundles:
        sys.exit("找不到武将语音包 assets_res_localsoundcdn_spell_*.ab")

    folders = {}          # folder -> [(clipName, obj, length)]
    folder_bundle = {}    # folder -> bundle 名
    t0 = time.time()
    for path in bundles:
        try:
            env = UnityPy.load(path)
        except Exception as exc:
            log("  跳过无法解析的包 %s（%s）" % (os.path.basename(path), exc))
            continue
        for obj in env.objects:
            if obj.type.name != "AudioClip":
                continue
            m = RE_SPELL_PATH.search(obj.container or "")
            if not m:
                continue
            folder = m.group(1)
            if folder.lower() == "card":
                continue
            clip = obj.read()
            folders.setdefault(folder, []).append(
                (clip.m_Name, obj, float(clip.m_Length or 0)))
            folder_bundle.setdefault(folder, os.path.basename(path))
    log("扫描 %d 个语音包，得到 %d 个武将目录 / %d 条 clip（%.1fs）"
        % (len(bundles), len(folders), sum(len(v) for v in folders.values()),
           time.time() - t0))

    # ---------------------------------------------------------- 目录匹配
    matched = {}          # gid -> {folder, pinyin, clips}
    unmatched = []        # (folder, 原因)
    mismatched = []       # (gid, name, 期望拼音, 实际拼音)
    for folder in sorted(folders):
        m = RE_FOLDER.match(folder)
        if not m:
            unmatched.append((folder, "目录名不含数字 ID 前缀"))
            continue
        gid, pinyin = int(m.group(1)), m.group(2)
        if gid not in generals:
            unmatched.append((folder, "ID %d 不在本项目 1~57 号武将内（皮肤/SP 版本）" % gid))
            continue
        expect = EXPECTED_PINYIN.get(gid, "")
        if expect and pinyin != expect:
            mismatched.append((gid, generals[gid], expect, pinyin))
        matched[gid] = {"folder": folder, "pinyin": pinyin,
                        "clips": folders[folder]}

    missing = [gid for gid in range(1, 58) if gid not in matched]
    log("匹配到 %d 名武将；无语音 %d 名：%s"
        % (len(matched), len(missing),
           ", ".join("%d %s" % (g, generals[g]) for g in missing) or "无"))
    if mismatched:
        log("注意：%d 个目录的拼音与武将名不符，已按 ID 匹配：" % len(mismatched))
        for gid, name, exp, got in mismatched:
            log("   %d %s：期望 %s，实际 %s" % (gid, name, exp, got))

    # ---------------------------------------------------------- 组织任务
    tasks = []            # (gid, out_name, clipName, obj, length)
    skipped_existing = 0
    for gid in sorted(matched):
        for clip_name, obj, length in sorted(matched[gid]["clips"],
                                             key=lambda x: natural_key(x[0])):
            m = RE_CLIP.match(clip_name)
            if not m:
                continue      # 非 skill/dead 命名的语音暂不纳入
            out_name = "general_%03d_%s.mp3" % (gid, clip_name)
            if not args.force and os.path.exists(os.path.join(OUT_DIR, out_name)):
                skipped_existing += 1
                continue
            tasks.append((gid, out_name, clip_name, obj, length))

    total_len = sum(t[4] for t in tasks)
    log("待导出 %d 条（音频总时长 %.1f 分钟）；已存在跳过 %d 条"
        % (len(tasks), total_len / 60.0, skipped_existing))

    if args.dry_run:
        per = {}
        for gid, _, _, _, _ in tasks:
            per[gid] = per.get(gid, 0) + 1
        for gid in sorted(per):
            log("  %3d %-6s %3d 条" % (gid, generals[gid], per[gid]))
        return 0

    # ---------------------------------------------------------- 导出
    if args.doc_only:
        log("--doc-only：跳过编码，仅按现有文件重建映射与文档")
        tasks = []
    os.makedirs(OUT_DIR, exist_ok=True)
    tmpdir = tempfile.mkdtemp(prefix="sgs_general_")
    written = []
    _seen_out = set()
    failures = []
    t0 = time.time()
    try:
        for idx, (gid, out_name, clip_name, obj, length) in enumerate(tasks, 1):
            out_path = os.path.join(OUT_DIR, out_name)
            try:
                if length <= 0.05:
                    raise RuntimeError("时长为 0")
                if length > 20.0:
                    raise RuntimeError("时长 %.1fs 异常（疑似占位/损坏音频）" % length)
                samples = obj.read().samples
                if not samples:
                    raise RuntimeError("解码结果为空")
                wav = list(samples.values())[0]
                peak = wav_peak(wav)
                if peak is not None and peak <= 32:
                    raise RuntimeError("数字静音（峰值 %d），判定为损坏素材" % peak)
                size = encode_mp3(wav, out_path, args.bitrate, tmpdir)
                if out_name not in _seen_out:
                    _seen_out.add(out_name)
                    written.append((gid, out_name, size))
            except Exception as exc:
                failures.append((gid, clip_name, str(exc)[:150]))
                if os.path.exists(out_path):
                    os.remove(out_path)
            if idx % 200 == 0:
                log("  已处理 %d/%d ..." % (idx, len(tasks)))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    total_bytes = sum(w[2] for w in written)
    log("导出完成：%d 个文件，%s，用时 %.1fs"
        % (len(written), human(total_bytes), time.time() - t0))
    if failures:
        log("失败 %d 条（详见文档）" % len(failures))

    # ---------------------------------------------------------- 映射
    groups = {}
    for gid, out_name, _ in written:
        groups.setdefault(gid, []).append(out_name)

    # 已存在但未参与的（上一次运行留下的）也纳入映射，保证 map 覆盖完整目录
    existing_by_gid = {}
    if os.path.isdir(OUT_DIR):
        for name in os.listdir(OUT_DIR):
            m = re.match(r"general_(\d{3})_(.+)\.mp3$", name)
            if m:
                existing_by_gid.setdefault(int(m.group(1)), set()).add(name)

    mapping = {}
    for gid in sorted(matched):
        all_names = sorted(existing_by_gid.get(gid, set()),
                           key=lambda n: natural_key(n.split("_", 2)[2].rsplit(".", 1)[0]))
        skills, deaths = [], []
        for name in all_names:
            clip = name.split("_", 2)[2].rsplit(".", 1)[0]
            m = RE_CLIP.match(clip)
            if not m:
                continue
            entry = "general/" + name
            kind = m.group(2) or ""
            if kind.startswith("dead") or kind.startswith("deda"):
                deaths.append(entry)
            else:
                skills.append(entry)
        mapping[str(gid)] = {"name": generals[gid], "skills": skills, "deaths": deaths}

    os.makedirs(os.path.dirname(MAP_PATH), exist_ok=True)
    with open(MAP_PATH, "w", encoding="utf-8") as fh:
        json.dump(mapping, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    log("映射已写入 %s" % os.path.relpath(MAP_PATH, ROOT))

    write_doc(generals, matched, missing, unmatched, mismatched, failures,
              written, skipped_existing, legacy_generals, total_bytes,
              args.bitrate, groups, mapping)
    log("文档已写入 %s" % os.path.relpath(DOC_PATH, ROOT))
    log("武将语音目录当前共 %d 个文件 / %s"
        % (len(os.listdir(OUT_DIR)),
           human(sum(os.path.getsize(os.path.join(OUT_DIR, f))
                     for f in os.listdir(OUT_DIR)))))
    return 0


def write_doc(generals, matched, missing, unmatched, mismatched, failures,
              written, skipped, legacy_generals, total_bytes, bitrate, groups, mapping):
    bad_clips = dict(KNOWN_BAD)
    for gid, clip, reason in failures:
        bad_clips[(gid, clip)] = reason

    lines = []
    a = lines.append
    a("# 武将语音映射")
    a("")
    a("> 本文件由 `tools/build_general_audio.py` 自动生成，请勿手工编辑。")
    a("")
    a("生成时间：%s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    a("")
    a("## 概览")
    a("")
    a("| 项目 | 数值 |")
    a("| --- | --- |")
    a("| 语音来源 | `Assets/Res/LocalSoundCDN/spell/<id><拼音>/` |")
    a("| 匹配武将目录 | %d 个（1~57 号中） |" % len(matched))
    total_bytes = sum(os.path.getsize(os.path.join(ROOT, "assets", "audio", p))
                      for v in mapping.values() for p in v["skills"] + v["deaths"])
    a("| 规范命名文件 | %d 个（%s） |"
      % (sum(len(v["skills"]) + len(v["deaths"]) for v in mapping.values()),
         human(total_bytes)))
    a("| 已存在跳过 | %d 个 |" % skipped)
    a("| 既有 audio_index 收录武将 | %d 名 |" % len(legacy_generals))
    a("| 无语音武将 | %d 名 |" % len(missing))
    a("| 未匹配目录 | %d 个 |" % len(unmatched))
    a("| 已跳过素材 | %d 条 |" % len(bad_clips))
    a("| 编码 | MP3 单声道 22050 Hz %s |" % bitrate)
    a("")
    a("命名规则：`general_<三位ID>_<clipName>.mp3`，clipName 自带皮肤号与序号，")
    a("例如 `general_001_1skill1_1.mp3`（刘备·皮肤1·技能1·第1条）。")
    a("同名文件默认跳过，不会覆盖既有资源。")
    a("")
    a("## 每名武将的语音数")
    a("")
    a("| ID | 武将 | 目录 | 技能 | 阵亡 | 合计 | 既有 |")
    a("| ---: | --- | --- | ---: | ---: | ---: | --- |")
    for gid in range(1, 58):
        if gid not in matched:
            continue
        info = mapping.get(str(gid), {})
        s, d = len(info.get("skills", [])), len(info.get("deaths", []))
        old = "有" if str(gid) in legacy_generals else "无"
        a("| %d | %s | `%s` | %d | %d | %d | %s |"
          % (gid, generals[gid], matched[gid]["folder"], s, d, s + d, old))
    a("")
    if missing:
        a("## 无语音武将")
        a("")
        a("原版资源包中**不存在**这些武将的 `spell/` 目录，无法补全：")
        a("")
        for gid in missing:
            a("- %d %s（来源文件夹缺失）" % (gid, generals[gid]))
        a("")
    if mismatched:
        a("## 拼音与武将名不一致的目录")
        a("")
        a("按数字 ID 匹配，拼音仅作交叉校验：")
        a("")
        a("| ID | 武将 | 期望拼音 | 实际拼音 |")
        a("| ---: | --- | --- | --- |")
        for gid, name, exp, got in mismatched:
            a("| %d | %s | `%s` | `%s` |" % (gid, name, exp, got))
        a("")
    if unmatched:
        a("## 未匹配目录")
        a("")
        a("这些目录的 ID 不在本项目 57 名武将内（多为皮肤/SP/界武将版本），未纳入：")
        a("")
        a("| 目录 | 原因 |")
        a("| --- | --- |")
        for folder, reason in unmatched:
            a("| `%s` | %s |" % (folder, reason))
        a("")
    if bad_clips:
        a("## 已跳过的素材")
        a("")
        for (gid, clip), reason in sorted(bad_clips.items()):
            a("- %d %s `%s`：%s" % (gid, generals.get(gid, ""), clip, reason))
        a("")
    a("## 与既有 audio_index.json 的关系")
    a("")
    a("此前 `assets/audio_index.json` 中每名武将只有 `general_XXX_skillN.mp3` /")
    a("`general_XXX_deathN.mp3`（仅皮肤 1、每条技能取 1 个变体，共 168 个文件）。")
    a("本次补全后新增了皮肤 2~5 与其余变体；旧文件**保留未动**，")
    a("因此 `general_001_skill1.mp3` 与 `general_001_1skill1_1.mp3` 是同一段原始音频的两次导出。")
    a("接入时可统一使用本映射（`out/general_audio_map.json`），旧文件可忽略。")
    a("")
    a("## 接入方式")
    a("")
    a("`out/general_audio_map.json` 的路径相对于 `assets/audio/`：")
    a("")
    a("```js")
    a("const g = MAP['1'];")
    a("SGS_AUDIO.playGeneral(1, 'skill');  // 从 g.skills 随机取一条")
    a("SGS_AUDIO.playGeneral(1, 'death');  // 从 g.deaths 随机取一条")
    a("```")
    a("")

    os.makedirs(os.path.dirname(DOC_PATH), exist_ok=True)
    with open(DOC_PATH, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


if __name__ == "__main__":
    sys.exit(main())
