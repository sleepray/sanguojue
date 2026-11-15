#!/bin/bash
# sgs-offline-apk 构建入口：把 ../sgs-offline 的静态包同步进 assets 后打 debug APK。
# 不修改 ../sgs-offline 与 ../sanguo-duel 的任何文件。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/sgs-offline"
DEST="$HERE/app/src/main/assets"

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$ROOT/.tools/gradle-home}"
export ANDROID_HOME="${ANDROID_HOME:-$ROOT/.tools/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"

# 1) 同步静态包（排除 out/docs/tools/artifacts/node_modules/zip）
mkdir -p "$DEST"
rsync -a --exclude='.DS_Store' \
  "$SRC/index.html" "$SRC/manifest.webmanifest" "$SRC/sw.js" "$DEST"/
# 只做增量覆盖，不使用 --delete：避免多源同步时误删 assets 根目录下的 index.html 等文件
rsync -a --exclude='.DS_Store' \
  "$SRC/css" "$SRC/js" "$SRC/assets" "$DEST"/

# 2) 构建（离线，使用工作区缓存）
cd "$HERE"
"$ROOT/.tools/gradle-8.13/bin/gradle" --offline --no-daemon --console=plain :app:assembleDebug

# 3) 输出到 artifacts
mkdir -p artifacts
cp app/build/outputs/apk/debug/app-debug.apk artifacts/sgs-offline.apk
echo "APK: $HERE/artifacts/sgs-offline.apk"
