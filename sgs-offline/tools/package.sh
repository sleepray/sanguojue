#!/usr/bin/env bash
# 三国杀·单机版 — 打包脚本
# ------------------------------------------------------------------
# 产出 artifacts/sgs-offline-<YYYYMMDD>.zip，并打印 zip 体积。
# 排除：out/、artifacts/、.venv/、node_modules/、.git/ 等开发期目录。
# ------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT_DIR="$(pwd)"
DATE="$(date +%Y%m%d)"
OUT_DIR="artifacts"
ZIP_NAME="sgs-offline-${DATE}.zip"
ZIP_PATH="${OUT_DIR}/${ZIP_NAME}"

if ! command -v zip >/dev/null 2>&1; then
  echo "错误：没有找到 zip 命令。" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
rm -f "${ZIP_PATH}"

echo "打包目录：${PROJECT_DIR}"
echo "输出文件：${ZIP_PATH}"
echo

# -X 去掉多余的扩展属性，保证跨机器解压一致
zip -r -q -X "${ZIP_PATH}" . \
  -x "out/*" \
  -x "artifacts/*" \
  -x ".venv/*" \
  -x "venv/*" \
  -x "node_modules/*" \
  -x ".git/*" \
  -x ".idea/*" \
  -x ".vscode/*" \
  -x "__pycache__/*" \
  -x "*/__pycache__/*" \
  -x "*.pyc" \
  -x "*/.DS_Store" \
  -x ".DS_Store"

if [ ! -f "${ZIP_PATH}" ]; then
  echo "错误：打包失败，未生成 ${ZIP_PATH}" >&2
  exit 1
fi

SIZE_BYTES="$(wc -c < "${ZIP_PATH}" | tr -d ' ')"
FILE_COUNT="$(unzip -Z1 "${ZIP_PATH}" | wc -l | tr -d ' ')"
SIZE_HUMAN="$(python3 - "${SIZE_BYTES}" <<'PY'
import sys
n = int(sys.argv[1])
for unit in ("B", "KB", "MB", "GB"):
    if n < 1024 or unit == "GB":
        print(("%.2f %s" % (n, unit)) if unit != "B" else ("%d B" % n))
        break
    n /= 1024.0
PY
)"

echo "----------------------------------------------"
echo "打包完成：${ZIP_PATH}"
echo "zip 体积：${SIZE_HUMAN}（${SIZE_BYTES} 字节）"
echo "包含文件：${FILE_COUNT} 个"
echo "----------------------------------------------"
