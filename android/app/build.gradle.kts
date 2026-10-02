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
        versionCode = 2
        versionName = "1.1.0"
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
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.5.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
}
