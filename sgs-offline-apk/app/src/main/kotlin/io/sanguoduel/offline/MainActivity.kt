package io.sanguoduel.offline

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.WebSettings
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import android.view.Gravity

/**
 * 最小 WebView 壳：全屏加载打包进 assets 的静态游戏，并处理返回键。
 * 不修改 sgs-offline 的任何源码；不申请网络权限。
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = createWebView()
        val root = FrameLayout(this)
        root.addView(webView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        val splash = TextView(this).apply {
            text = "三国杀"
            setTextColor(0xFFE9C26A.toInt())
            textSize = 34f
            gravity = Gravity.CENTER
            setBackgroundColor(0xFF07090B.toInt())
        }
        root.addView(splash, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)
        // DecorView 尚未 attach 时 getInsetsController 会 NPE；延后到首帧后再全屏
        window.decorView.post { goFullscreen() }
        applyDisplayCutoutPadding()
        webView.loadUrl(ASSET_URL)
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                return !url.startsWith("file://")
            }
            override fun onPageFinished(view: WebView, url: String) {
                splash.animate().alpha(0f).setDuration(220).withEndAction {
                    root.removeView(splash)
                }.start()
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT
            ) { handleBack() }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Suppress("DEPRECATION")
    private fun createWebView(): WebView = WebView(this).apply {
        WebView.setWebContentsDebuggingEnabled(true)
        setBackgroundColor(0xFF000000.toInt())
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = true
            allowContentAccess = true
            // file:// 页面内的本地资源读取（Android 11+ 对 targetSdk>=30 会忽略这两项，
            // 但低版本设备仍需要，且对 WebView 自身加载 assets 无影响）
            allowFileAccessFromFileURLs = true
            allowUniversalAccessFromFileURLs = true
            cacheMode = WebSettings.LOAD_DEFAULT
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            javaScriptCanOpenWindowsAutomatically = true
            textZoom = 100
        }
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                Log.e("WebViewConsole", "${msg.message()} @ ${msg.sourceId()}:${msg.lineNumber()}")
                return true
            }
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                // 纯离线游戏：只放行 file:// 内部跳转；外链一律拦下（本应用也没有网络权限）
                return !url.startsWith("file://")
            }
        }
    }


    /** 真机刘海/挖孔：给 WebView 加 padding，避免顶栏被 displayCutout 遮挡 */
    private fun applyDisplayCutoutPadding() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            webView.setOnApplyWindowInsetsListener { v, insets ->
                val cut = insets.getInsets(WindowInsets.Type.displayCutout())
                v.setPadding(cut.left, cut.top, cut.right, cut.bottom)
                insets
            }
            webView.requestApplyInsets()
        }
    }

    @Suppress("DEPRECATION")
    private fun goFullscreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.setDecorFitsSystemWindows(false)
            window.insetsController?.apply {
                hide(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    or View.SYSTEM_UI_FLAG_FULLSCREEN
                    or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                )
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun handleBack() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            finish()
        }
    }

    @Deprecated("Android 13+ 由 OnBackInvokedCallback 处理")
    override fun onBackPressed() {
        handleBack()
    }

    private var backgroundPaused = false

    override fun onResume() {
        super.onResume()
        backgroundPaused = false
        webView.resumeTimers()
        webView.onResume()
        // 不在这里恢复引擎：等玩家点“继续游戏”，避免恢复瞬间快进
        goFullscreen()
    }

    override fun onPause() {
        pauseForBackground()
        super.onPause()
    }

    override fun onStop() {
        pauseForBackground()
        super.onStop()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) pauseForBackground()
    }

    private fun pauseForBackground() {
        if (!::webView.isInitialized || backgroundPaused) return
        backgroundPaused = true
        android.util.Log.i("SGS_LIFE", "pauseForBackground")
        // 必须在暂停计时器之前把暂停状态送进 JS；回调确认后再冻结 WebView
        webView.evaluateJavascript("window.SGS_APP_PAUSE && SGS_APP_PAUSE(true); window.__SGS_LAST_PAUSE = true;", android.webkit.ValueCallback { value ->
            android.util.Log.i("SGS_LIFE", "pause JS callback=$value")
            webView.postDelayed({
                if (backgroundPaused) {
                    webView.pauseTimers()
                    webView.onPause()
                    android.util.Log.i("SGS_LIFE", "pauseTimers applied")
                }
            }, 80)
        })
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            (webView.parent as? android.view.ViewGroup)?.removeView(webView)
            webView.destroy()
        }
        super.onDestroy()
    }

    private companion object {
        const val ASSET_URL = "file:///android_asset/index.html"
    }
}
