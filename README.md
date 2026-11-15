# 三国杀 · 单机版

离线单机三国杀：Web 版本体 + Android WebView 壳。

## 目录

- `sgs-offline/`：HTML/CSS/JS、武将/技能/卡牌数据、音频与图片素材；
- `sgs-offline-apk/`：最小 Android WebView 工程，构建时从 `sgs-offline` 同步静态包到 assets；
- 构建产物不提交（`sgs-offline/out`、`sgs-offline/artifacts`、Gradle build/cache）。

## Web 本地运行

```bash
cd sgs-offline
python3 tools/serve.py 8899
# open http://127.0.0.1:8899/
```

## Android APK

需要 JDK / Android SDK / Gradle；工程默认使用工作区 `.tools` 下的工具链。

```bash
cd sgs-offline-apk
./build.sh
# 输出 sgs-offline-apk/artifacts/sgs-offline.apk
```

## 说明

音频、立绘、卡图来自本地原版资源包；仓库只用于源码维护，不包含构建产物。
