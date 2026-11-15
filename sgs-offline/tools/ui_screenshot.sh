#!/usr/bin/env bash
# 三国杀 · 单机版 — UI 截图脚本
# 用法：bash tools/ui_screenshot.sh [输出目录]
# 依赖：macOS 上的 Google Chrome（可用 CHROME_BIN 覆盖）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/out}"
CHROME="${CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [[ ! -x "$CHROME" ]]; then
  echo "找不到 Chrome：$CHROME" >&2
  echo "请设置 CHROME_BIN=/path/to/Chrome" >&2
  exit 1
fi
mkdir -p "$OUT"
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/sgs_ui_shot.XXXXXX")"
trap 'rm -rf "$TMPBASE"' EXIT

BASE="file://$ROOT/index.html"

shot() {
  local name="$1" url="$2" w="$3" h="$4" budget="$5"
  local profile="$TMPBASE/$name"
  mkdir -p "$profile"
  "$CHROME" \
    --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=1 \
    --user-data-dir="$profile" \
    --virtual-time-budget="$budget" \
    --screenshot="$OUT/$name.png" \
    --window-size="$w,$h" \
    "$url" >/dev/null 2>&1
  printf '  ✓ %s.png (%s)\n' "$name" "$(du -h "$OUT/$name.png" | cut -f1)"
}

echo "输出目录：$OUT"
echo "主菜单与选将…"
shot ui_home              "$BASE?nofx=1" 1600 900 1200
shot ui_home_1v1          "$BASE?nofx=1&mode=1v1&pace=fast" 1600 900 1200
shot ui_select            "$BASE?nofx=1&screen=select&seed=8" 1600 900 2500
shot ui_select_standard   "$BASE?nofx=1&screen=select&seed=8&packs=%E6%A0%87%E5%87%86" 1600 900 2500
shot ui_1v1_select        "$BASE?nofx=1&screen=select&mode=1v1&seed=8" 1600 900 2500

echo "对局牌桌…"
shot ui_table             "$BASE?nofx=1&demo=1&freeze=play&seed=8&speed=0" 1600 900 8000
shot ui_response          "$BASE?nofx=1&demo=1&freeze=response&seed=8&speed=0" 1600 900 16000
shot ui_5p                "$BASE?nofx=1&demo=1&freeze=play&seed=8&mode=5p&speed=0" 1600 900 9000
shot ui_1v1               "$BASE?nofx=1&demo=1&freeze=play&mode=1v1&seed=8&speed=0" 1600 900 7000
shot ui_1v1_portrait      "$BASE?nofx=1&demo=1&freeze=play&mode=1v1&seed=8&speed=0" 900 1400 7000
shot ui_portrait          "$BASE?nofx=1&demo=1&freeze=play&seed=8&speed=0" 900 1400 8000
shot ui_log               "$BASE?nofx=1&demo=1&freeze=play&seed=8&speed=0&log=1" 1600 900 9000

echo "请求弹窗…"
PREVIEW="$BASE?nofx=1&demo=1&freeze=play&seed=8&speed=0"
shot ui_modal_cards       "$PREVIEW&preview=chooseCards" 1600 900 8000
shot ui_modal_targets     "$PREVIEW&preview=chooseTargets" 1600 900 8000
shot ui_modal_arrange     "$PREVIEW&preview=arrange" 1600 900 8000
shot ui_modal_from        "$PREVIEW&preview=chooseCardFrom" 1600 900 8000
shot ui_modal_distribute  "$PREVIEW&preview=distribute" 1600 900 8000
shot ui_modal_option      "$PREVIEW&preview=chooseOption" 1600 900 8000
shot ui_modal_pick        "$PREVIEW&preview=pickFrom" 1600 900 8000

echo "结算…"
shot ui_result            "$BASE?nofx=1&screen=result&seed=8&speed=0" 1600 900 30000
shot ui_1v1_result        "$BASE?nofx=1&screen=result&mode=1v1&seed=8&speed=0" 1600 900 60000
shot ui_1v1_result_win    "$BASE?nofx=1&screen=result&mode=1v1&seed=2&speed=0" 1600 900 30000
shot ui_1v1_result_lose   "$BASE?nofx=1&screen=result&mode=1v1&seed=1&speed=0" 1600 900 30000

echo "完成，共 $(find "$OUT" -maxdepth 1 -name 'ui_*.png' | wc -l | tr -d ' ') 张 UI 截图。"
