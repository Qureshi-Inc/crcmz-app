import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}

// The signing key lives outside the repo (~/.crcmz-android); see android/README.md.
val keyDir = File(System.getenv("CRCMZ_KEY_DIR") ?: "${System.getProperty("user.home")}/.crcmz-android")
val keyPass = File(keyDir, "keystore.pass").takeIf { it.exists() }?.readText()?.trim()

android {
    namespace = "me.crcmz.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "me.crcmz.app"
        minSdk = 24
        targetSdk = 35
        versionCode = 11
        versionName = "2.0.8"
        // Phones only: LiveKit's native libraries for emulator chips would double the APK.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    signingConfigs {
        if (keyPass != null) create("crcmz") {
            storeFile = File(keyDir, "crcmz-upload.jks")
            storePassword = keyPass
            keyAlias = "crcmz"
            keyPassword = keyPass
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("crcmz")
        }
        debug {
            // Same key as release so asset links verify on a debug install too.
            signingConfig = signingConfigs.findByName("crcmz")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.lifecycle:lifecycle-service:2.8.7")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // Huddle and the Watch Party's camera call (NativeCall.kt), like the iOS app.
    implementation("io.livekit:livekit-android:2.29.0")
    // Slap (NativeAudio.kt): plays with the screen off, lock screen, Android Auto.
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-session:1.5.1")
    implementation("androidx.media3:media3-datasource-okhttp:1.5.1")
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
}
