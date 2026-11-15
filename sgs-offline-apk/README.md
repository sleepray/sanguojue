# sgs-offline-apk

把 `../sgs-offline` 的静态 Web 游戏（三国杀·单机版）封装成最小 WebView Android APK。
**不修改** `sgs-offline` 源码；只把 `index.html`、`manifest.webmanifest`、`sw.js`、`css/`、`js/`、`assets/` 复制进 `app/src/main/assets/`。

## 产物

| 项 | 值 |
| --- | --- |
| APK | `artifacts/sgs-offline.apk` |
| 大小 | 118,456,888 字节（约 113 MiB） |
| SHA-256 | `00daf96994d2580ab1dbc4f95d5adbef9e46bb5809c8e20fe48746b04c5fb49e` |
| applicationId | `io.sanguoduel.offline` |
| versionName | `1.0.0-2026.11.14`（versionCode 1） |
| minSdk / targetSdk / compileSdk | 26 / 36 / 36 |
| 入口 | `io.sanguoduel.offline.MainActivity` |
| 签名 | debug keystore（`keystore/debug.keystore`），APK Signature Scheme v2 |
| 权限 | 无（未声明 INTERNET / 存储 / 定位等） |
| assets 文件数 | 1956 |

## 壳实现

- 全屏 `WebView` 加载 `file:///android_asset/index.html`。
- 开启 JS、DOM Storage、Database、文件访问、媒体自动播放（`mediaPlaybackRequiresUserGesture = false`）。
- `sensorLandscape` 横屏，`configChanges` 自行处理旋转，避免重建。
- 隐藏状态栏/导航栏（Android 11+ 用 `WindowInsetsController`，低版本用 immersive flags），刘海屏 `shortEdges`。
- 返回键：WebView 可后退则 `goBack()`，否则 `finish()`；Android 13+ 使用 `OnBackInvokedCallback`，低版本走 `onBackPressed()`。
- 纯离线：不申请网络权限，WebView 拦截一切非 `file://` 跳转。
- 无 AndroidX 依赖，仅 Kotlin 标准库。

## 构建

环境要求：JDK 17+、Android SDK platform 36 + build-tools 36.0.0、Gradle 8.13（工作区自带）。

```bash
cd sgs-offline-apk
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
GRADLE_USER_HOME="$PWD/../.tools/gradle-home" \
ANDROID_HOME="$PWD/../.tools/android-sdk" \
../.tools/gradle-8.13/bin/gradle --offline --no-daemon --console=plain :app:assembleDebug
cp app/build/outputs/apk/debug/app-debug.apk artifacts/sgs-offline.apk
```

或直接 `./build.sh`（会先把 `../sgs-offline` 的最新静态包同步进 assets）。

## 校验

```bash
AAPT=$PWD/../.tools/android-sdk/build-tools/36.0.0/aapt
$AAPT dump badging artifacts/sgs-offline.apk | grep -E "^package:|^sdkVersion|^targetSdkVersion|^launchable-activity"
unzip -l artifacts/sgs-offline.apk | awk '$4 ~ /^assets\// && $1 != "0" {n++} END {print n}'   # 1956
apksigner verify --verbose --print-certs artifacts/sgs-offline.apk
```

`aapt dump badging` 关键输出：

```text
package: name='io.sanguoduel.offline' versionCode='1' versionName='1.0.0-2026.11.14' ... compileSdkVersion='36'
sdkVersion:'26'
targetSdkVersion:'36'
application-label:'三国杀·单机版'
launchable-activity: name='io.sanguoduel.offline.MainActivity'
```

## 已知限制

1. **音频索引降级**：`js/audio.js` 用 `fetch('assets/audio_index.json')` 读索引，Chromium 的 `fetch` 不支持 `file://` 协议，因此索引加载会失败并走代码内置兜底。兜底路径的 14 个 SFX 与 2 个 BGM 文件均已确认存在，BGM/通用音效正常；卡牌/武将专属语音会退化为通用出牌音效。未修改游戏源码来规避。
2. **Service Worker 不生效**：`main.js` 仅在 `http/https` 注册 SW，`file://` 下自动跳过；APK 内静态资源已本地化，不依赖 SW 缓存。
3. **`allowFileAccessFromFileURLs` 在 targetSdk 30+ 被系统忽略**：这是 Android 平台限制，不影响 `file:///android_asset` 主页面与 `<script>/<img>/<audio>` 加载；只影响 file:// 页面内的 XHR/fetch（同第 1 条）。
4. **未做真机/模拟器验证**：按要求未启动模拟器；当前验证为静态校验（aapt/apksigner/unzip/DEX）。运行时表现依赖设备 System WebView 版本。
5. **仅 debug 签名**：v2 签名，适合侧载安装，不适合上架分发。
6. **source 快照**：构建期间 `sgs-offline/css/style.css` 于 22:42:40 被外部追加了手机端响应式样式；本 APK 已在 22:43 重新同步并包含该最新版本，之后源目录未再变化（逐文件比对一致）。
