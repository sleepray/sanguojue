import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.sanguoduel.offline"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "io.sanguoduel.offline"
        minSdk = 26
        targetSdk = 36
        versionCode = 8
        versionName = "1.0.7-2026.11.16"
    }

    signingConfigs {
        // 固定使用工程内的调试签名，避免写 ~/.android/debug.keystore
        getByName("debug") {
            storeFile = rootProject.file("keystore/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

// 纯 WebView 壳：不依赖 AndroidX / AppCompat，只需要 Kotlin 标准库（由插件自动添加）。
dependencies {
}
