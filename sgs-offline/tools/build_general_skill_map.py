#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""三国杀·单机版 — 武将技能级音频映射

背景：`general_<id>_<皮肤>skill<槽位>_<性别>.mp3` 里的**槽位号是原版的**，
和 `js/data.js` 里 `skills` 的书写顺序不一定一致。实测有 4 名武将对不上：

    21 甄姬   data.js [倾国, 洛神]  原版槽位 [洛神, 倾国]
    24 貂蝉   data.js [离间, 闭月]  原版槽位 [闭月, 离间]
    25 孙尚香 data.js [结姻, 枭姬]  原版槽位 [枭姬, 结姻]
    39 庞德   data.js [马术, 猛进]  原版还混入其它版本的骁袭/鞬出

所以本脚本**按技能名**对齐，而不是按位置：
  1. `js/data.js` 的 GENERALS[].skills → 技能 key + 中文名（经 SKILLS）
  2. 原版 `list2.sgs` 的 `sys_h5_music.heromusic`：`a`=武将ID、`d`=技能名、
     `f`=男声路径、`g`=女声路径、`e=1`=阵亡
  3. 路径 basename 对应本地 `assets/audio/general/general_<id>_<basename>.mp3`

产物：out/general_audio_map.json
    { "1": { "rende": ["general/general_001_1skill1_1.mp3", ...],
             "jijiang": [...], "death": [...] }, ... }

用法：
    python3 tools/build_general_skill_map.py
    python3 tools/build_general_skill_map.py --dry-run
"""

import argparse
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_SRC = "/Users/chenlei/WorkBuddy/2026-10-26-13-50-39/sgs_offline"
SRC_ROOT = os.environ.get("SGS_SRC") or DEFAULT_SRC
LIST2 = os.path.join(SRC_ROOT, "assets", "AppCfgData", "list2.sgs")
DATA_JS = os.path.join(ROOT, "js", "data.js")
GENERAL_DIR = os.path.join(ROOT, "assets", "audio", "general")
MAP_PATH = os.path.join(ROOT, "out", "general_audio_map.json")


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def load_generals():
    """读 js/data.js（只读）拿 GENERALS 与 SKILLS 中文名。"""
    js = r"""
const fs=require('fs'); global.window=global;
new Function('window', fs.readFileSync(process.argv[1],'utf8'))(global);
const D=global.SGS_DATA;
console.log(JSON.stringify(D.GENERALS.map(g=>({id:g.id,name:g.name,gender:g.gender,
  skills:g.skills.map(k=>({key:k,cn:(D.SKILLS[k]&&D.SKILLS[k].name)||k}))}))));
"""
    out = subprocess.run(["node", "-e", js, DATA_JS],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if out.returncode != 0:
        sys.exit("读取 js/data.js 失败：%s" % out.stderr.decode("utf-8", "replace")[:300])
    return json.loads(out.stdout.decode("utf-8"))


def load_heromusic():
    with open(LIST2, encoding="utf-8") as fh:
        cfg = json.load(fh)
    entries = cfg.get("sys_h5_music", {}).get("root", {}).get("heromusic", [])
    if not entries:
        sys.exit("list2.sgs 中找不到 sys_h5_music.root.heromusic")
    by_id = {}
    for e in entries:
        by_id.setdefault(str(e.get("a")), []).append(e)
    return by_id


def skin_index(path):
    """从 1liubei/2skill1_1 里取皮肤号 2，用于稳定排序。"""
    import re
    base = path.split("/")[-1]
    m = re.match(r"^(\d+)", base)
    return int(m.group(1)) if m else 0


def gender_index(path):
    """文件名最后一段 _1=男、_2=女。"""
    base = path.split("/")[-1]
    return 1 if base.endswith("_1") else 2 if base.endswith("_2") else 0


def main():
    ap = argparse.ArgumentParser(description="生成武将技能级音频映射")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    generals = load_generals()
    hero = load_heromusic()
    local = set(os.listdir(GENERAL_DIR)) if os.path.isdir(GENERAL_DIR) else set()
    log("武将 %d 名 / heromusic 武将 %d 组 / 本地语音 %d 个文件"
        % (len(generals), len(hero), len(local)))

    mapping = {}
    rows = []          # 逐技能状态，供文档使用
    stats = {"ok": 0, "no-voice": 0, "no-general": 0, "absent": 0, "uncertain": 0}
    order_conflicts = []

    for g in generals:
        gid = g["id"]
        entries = hero.get(str(gid), [])
        skill_entries = [e for e in entries if not e.get("e")]
        cfg_names = []
        for e in skill_entries:
            if e.get("d") and e["d"] not in cfg_names:
                cfg_names.append(e["d"])
        data_names = [s["cn"] for s in g["skills"]]
        if cfg_names and cfg_names[:len(data_names)] != data_names:
            order_conflicts.append({
                "gid": gid, "name": g["name"],
                "data": data_names, "config": cfg_names[:len(data_names)],
            })

        node = {}
        for sk in g["skills"]:
            cand = [e for e in skill_entries if e.get("d") == sk["cn"]]
            paths = []
            for e in cand:
                for fld in ("f", "g"):
                    p = e.get(fld)
                    if p:
                        paths.append(p)
            # 去重后按 皮肤→性别 排序，方便阅读
            paths = sorted(set(paths), key=lambda p: (skin_index(p), gender_index(p)))
            files = []
            for p in paths:
                fn = "general_%03d_%s.mp3" % (gid, p.split("/")[-1])
                # 同一武将的多个版本条目可能给出同名 basename，按最终文件名去重
                if fn in local and ("general/" + fn) not in files:
                    files.append("general/" + fn)

            if files:
                status = "ok"
            elif paths:
                status = "absent"
            elif cand:
                status = "no-voice"
            elif not entries:
                status = "no-general"
            else:
                # 该武将有配置，但这个技能名找不到 —— 可能是改名，不硬塞
                status = "uncertain"
            stats[status] += 1
            node[sk["key"]] = files
            rows.append({
                "gid": gid, "gname": g["name"], "skill_key": sk["key"],
                "skill": sk["cn"], "status": status,
                "files": files, "cfg_files": len(paths),
                "text": next((e.get("m") for e in cand if e.get("m")), ""),
            })

        # 阵亡
        death_paths, death_cfg = [], 0
        for e in entries:
            if not e.get("e"):
                continue
            death_cfg += 1
            p = e.get("f")
            if p:
                death_paths.append(p)
        death_paths = sorted(set(death_paths), key=lambda p: (skin_index(p), gender_index(p)))
        death_files = []
        for p in death_paths:
            fn = "general_%03d_%s.mp3" % (gid, p.split("/")[-1])
            if fn in local and ("general/" + fn) not in death_files:
                death_files.append("general/" + fn)
        node["death"] = death_files
        rows.append({"gid": gid, "gname": g["name"], "skill_key": "death",
                     "skill": "阵亡", "status": "ok" if death_files else
                     ("no-general" if not entries else "no-voice"),
                     "files": death_files, "cfg_files": death_cfg,
                     "text": next((e.get("m") for e in entries if e.get("e")), "")})
        mapping[str(gid)] = node

    log("技能状态：" + " / ".join("%s=%d" % kv for kv in sorted(stats.items())))
    log("槽位顺序与 data.js 不一致的武将：%d 名" % len(order_conflicts))
    for c in order_conflicts:
        log("  %d %s  data=%s  config=%s"
            % (c["gid"], c["name"], "/".join(c["data"]), "/".join(c["config"])))

    if args.dry_run:
        for gid in ("1", "2", "15"):
            log("  %s -> %s" % (gid, json.dumps(mapping.get(gid, {}), ensure_ascii=False)[:220]))
        return 0

    # 严格按约定结构输出：{ "<gid>": { "<skillKey>": [...], "death": [...] } }
    # 统计与顺序冲突只写进文档，不塞进 JSON，避免消费方把 _meta 当成武将
    payload = dict(mapping)
    os.makedirs(os.path.dirname(MAP_PATH), exist_ok=True)
    with open(MAP_PATH, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    log("已写入 %s（%d 名武将）" % (os.path.relpath(MAP_PATH, ROOT), len(mapping)))

    return 0


if __name__ == "__main__":
    sys.exit(main())
