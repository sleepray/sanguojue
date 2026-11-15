#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""三国杀·单机版 — 体积报告

统计 assets/ 各子目录、其它工程目录以及整包体积，输出到 out/size_report.txt。

"可打包体积"排除了打包脚本会忽略的内容（out/、artifacts/、.venv/、
node_modules/、.git/、__pycache__ 等），它才是真正打进 zip 的体积；
"全项目体积"则是当前工作目录下的全部文件。

用法：
    python3 tools/size_report.py
    python3 tools/size_report.py --target-mb 100 --limit-mb 200

当可打包体积超过硬上限时，脚本以退出码 1 结束，方便在打包流程里拦截。
"""

import argparse
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets")
REPORT = os.path.join(ROOT, "out", "size_report.txt")

# 与 tools/package.sh 的排除规则保持一致
EXCLUDE_DIRS = {
    "out", "artifacts", ".venv", "venv", "node_modules", ".git",
    "__pycache__", ".idea", ".vscode", ".DS_Store",
}
EXCLUDE_FILES = {".DS_Store"}

MB = 1024.0 * 1024.0


def human(nbytes):
    if nbytes >= MB:
        return "%.2f MB" % (nbytes / MB)
    if nbytes >= 1024:
        return "%.1f KB" % (nbytes / 1024.0)
    return "%d B" % nbytes


def dir_stats(path, exclude=False):
    """递归统计目录：返回 (文件数, 字节数, 最大的若干个文件)。"""
    count = 0
    total = 0
    largest = []
    if not os.path.isdir(path):
        return 0, 0, largest
    for base, dirs, files in os.walk(path):
        if exclude:
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for name in files:
            if exclude and name in EXCLUDE_FILES:
                continue
            full = os.path.join(base, name)
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            count += 1
            total += size
            largest.append((size, os.path.relpath(full, ROOT)))
    largest.sort(reverse=True)
    return count, total, largest[:10]


def subdirs(path):
    if not os.path.isdir(path):
        return []
    return sorted(d for d in os.listdir(path)
                  if os.path.isdir(os.path.join(path, d)))


def file_stats(path):
    if not os.path.isfile(path):
        return 0, 0
    try:
        return 1, os.path.getsize(path)
    except OSError:
        return 0, 0


def pct(part, whole):
    return ("%.1f%%" % (100.0 * part / whole)) if whole else "-"


def main():
    parser = argparse.ArgumentParser(description="统计工程体积并判定是否超标")
    parser.add_argument("--target-mb", type=float, default=100.0,
                        help="期望体积上限(MB)，默认 100")
    parser.add_argument("--limit-mb", type=float, default=200.0,
                        help="硬性体积上限(MB)，默认 200")
    parser.add_argument("--quiet", action="store_true", help="不打印到终端")
    args = parser.parse_args()

    # ------------------------------------------------------------ 采集数据
    asset_rows = []           # (相对路径, 文件数, 字节数)
    assets_total_files = 0
    assets_total_bytes = 0
    for name in subdirs(ASSETS):
        full = os.path.join(ASSETS, name)
        c, b, _ = dir_stats(full)
        asset_rows.append(("assets/%s/" % name, c, b))
        assets_total_files += c
        assets_total_bytes += b
    # assets 根目录下散落的文件
    root_files_c, root_files_b = 0, 0
    if os.path.isdir(ASSETS):
        for name in sorted(os.listdir(ASSETS)):
            full = os.path.join(ASSETS, name)
            if os.path.isfile(full):
                c, b = file_stats(full)
                root_files_c += c
                root_files_b += b
    if root_files_c:
        asset_rows.append(("assets/*.* (根目录文件)", root_files_c, root_files_b))
    assets_total_files += root_files_c
    assets_total_bytes += root_files_b
    asset_rows.sort(key=lambda r: r[2], reverse=True)

    # 其它顶层目录
    other_rows = []
    other_files = 0
    other_bytes = 0
    excluded_files = 0
    excluded_bytes = 0
    loose_files = 0
    loose_bytes = 0
    for name in sorted(os.listdir(ROOT)):
        full = os.path.join(ROOT, name)
        if name == "assets":
            continue
        if os.path.isdir(full):
            c, b, _ = dir_stats(full)
            if name in EXCLUDE_DIRS:
                excluded_files += c
                excluded_bytes += b
                other_rows.append((name + "/ (不打包)", c, b))
            else:
                other_rows.append((name + "/", c, b))
                other_files += c
                other_bytes += b
        elif os.path.isfile(full):
            if name in EXCLUDE_FILES:
                continue
            c, b = file_stats(full)
            loose_files += c
            loose_bytes += b

    package_files = assets_total_files + other_files + loose_files
    package_bytes = assets_total_bytes + other_bytes + loose_bytes
    project_files = package_files + excluded_files
    project_bytes = package_bytes + excluded_bytes

    _, _, biggest = dir_stats(ROOT, exclude=True)

    # 音频按分组再拆一层，方便观察预算
    audio_rows = []
    audio_dir = os.path.join(ASSETS, "audio")
    if os.path.isdir(audio_dir):
        for name in subdirs(audio_dir):
            c, b, _ = dir_stats(os.path.join(audio_dir, name))
            audio_rows.append(("assets/audio/%s/" % name, c, b))
        audio_rows.sort(key=lambda r: r[2], reverse=True)

    # ------------------------------------------------------------ 生成报告
    lines = []

    def add(s=""):
        lines.append(s)

    add("=" * 72)
    add("三国杀·单机版 — 体积报告")
    add("=" * 72)
    add("生成时间 : %s" % time.strftime("%Y-%m-%d %H:%M:%S"))
    add("工程目录 : %s" % ROOT)
    add("统计口径 : 可打包体积 = 排除 %s" % ", ".join(sorted(EXCLUDE_DIRS)))
    add("")

    add("-" * 72)
    add("一、assets/ 各目录")
    add("-" * 72)
    add("%-30s %8s %12s %8s" % ("目录", "文件数", "体积", "占比"))
    for rel, c, b in asset_rows:
        add("%-30s %8d %12s %8s" % (rel, c, human(b), pct(b, assets_total_bytes)))
    add("%-30s %8d %12s %8s" % ("assets/ 合计", assets_total_files,
                                human(assets_total_bytes),
                                pct(assets_total_bytes, package_bytes)))
    add("")

    if audio_rows:
        add("-" * 72)
        add("二、assets/audio/ 明细")
        add("-" * 72)
        add("%-30s %8s %12s %8s" % ("分组", "文件数", "体积", "占比"))
        for rel, c, b in audio_rows:
            add("%-30s %8d %12s %8s" % (rel, c, human(b), pct(b, assets_total_bytes)))
        add("")

    add("-" * 72)
    add("三、其它目录")
    add("-" * 72)
    add("%-30s %8s %12s %8s" % ("目录", "文件数", "体积", "占比"))
    for rel, c, b in other_rows:
        add("%-30s %8d %12s %8s" % (rel, c, human(b), pct(b, package_bytes)))
    add("%-30s %8d %12s %8s" % ("根目录散落文件", loose_files, human(loose_bytes),
                                pct(loose_bytes, package_bytes)))
    add("")

    add("-" * 72)
    add("四、总计")
    add("-" * 72)
    add("%-30s %8d %12s" % ("可打包体积（进 zip）", package_files, human(package_bytes)))
    add("%-30s %8d %12s" % ("全项目体积（含被排除项）", project_files, human(project_bytes)))
    if excluded_files:
        share = 100.0 * excluded_bytes / project_bytes if project_bytes else 0.0
        add("%-30s %8d %12s" % ("其中：打包时排除", excluded_files, human(excluded_bytes)))
        add("说明：排除项占全项目 %.1f%%，打包后即不含这些内容。" % share)
    add("")

    add("-" * 72)
    add("五、体积判定")
    add("-" * 72)
    target_bytes = args.target_mb * MB
    limit_bytes = args.limit_mb * MB
    ok_target = package_bytes <= target_bytes
    ok_limit = package_bytes <= limit_bytes
    add("目标 < %.0f MB : %s（可打包体积 %s，余量 %s）"
        % (args.target_mb, "PASS" if ok_target else "未达成",
           human(package_bytes), human(abs(target_bytes - package_bytes))))
    add("硬上限 < %.0f MB : %s（可打包体积 %s，余量 %s）"
        % (args.limit_mb, "PASS" if ok_limit else "FAIL",
           human(package_bytes), human(abs(limit_bytes - package_bytes))))
    if not ok_limit:
        add("警告：整包已超过硬上限，请先清理素材再打包。")
    add("")

    if biggest:
        add("-" * 72)
        add("六、最大的 10 个文件")
        add("-" * 72)
        for size, rel in biggest:
            add("  %10s  %s" % (human(size), rel))
        add("")

    add("=" * 72)
    add("结论：%s" % ("整包体积正常" if ok_limit else "整包体积超标"))
    add("=" * 72)

    text = "\n".join(lines) + "\n"
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as fh:
        fh.write(text)

    if not args.quiet:
        sys.stdout.write(text)
        sys.stdout.flush()

    return 0 if ok_limit else 1


if __name__ == "__main__":
    sys.exit(main())
