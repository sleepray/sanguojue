#!/bin/bash
# 三国杀·单机版 — macOS 双击启动
# ------------------------------------------------------------------
# 做的事：切到本脚本所在目录 → 用 python3 起一个本地静态服务器 →
#        自动打开浏览器 → 关闭窗口（或 Ctrl+C）即结束服务。
# 全程离线，不访问外网；服务器只监听 127.0.0.1。
# ------------------------------------------------------------------

# 双击运行时当前目录是用户主目录，必须切到脚本所在目录
cd "$(dirname "$0")" || {
  echo "无法进入脚本所在目录，请手动从终端运行。"
  read -r -p "按回车键关闭窗口..."
  exit 1
}

PORT=8787
URL="http://127.0.0.1:${PORT}/"

echo "=============================================="
echo "  三国杀 · 单机版"
echo "  目录：$(pwd)"
echo "  地址：${URL}"
echo "=============================================="
echo

if ! command -v python3 >/dev/null 2>&1; then
  echo "没有找到 python3。macOS 请先安装命令行工具："
  echo "    xcode-select --install"
  echo "或安装 Python 3：https://www.python.org/downloads/"
  echo
  read -r -p "按回车键关闭窗口..."
  exit 1
fi

# 端口已被占用时不再重复起服务，直接打开已有页面
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 ${PORT} 已在监听，直接打开浏览器。"
  open "${URL}"
  exit 0
fi

# 后台等待服务就绪后再开浏览器（最多约 6 秒）
(
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null "${URL}" 2>/dev/null; then
      open "${URL}"
      exit 0
    fi
    sleep 0.2
  done
  open "${URL}"
) &

echo "服务已启动。关闭本窗口或按 Ctrl+C 结束游戏服务。"
echo
# exec 让 python 接管当前进程，Ctrl+C 直接结束服务
exec python3 tools/serve.py "${PORT}"
