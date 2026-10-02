# CRCMZ Android app

`me.crcmz.app`: app.crcmz.me/app full screen in Chrome (a Trusted Web Activity), plus
one native piece: a Huddle or Watch Party starting **rings** like a phone call
(full screen over the lock screen, Join / Decline, ringtone for 30s).

Everything else (pages, sign-in, passkeys, Web Push, calls, background audio) is the
website, so a site deploy updates the app. Rebuild only for changes in this folder.

## How the pieces connect

- `LauncherActivity.kt` asks for notification permission once, gets the FCM token and
  opens `/app?crcmz_app=android&crcmz_fcm=<token>`.
- `frontend/src/lib/native.ts` strips those params and posts the token (and this
  phone's Web Push endpoint) to `/api/push/native`.
- `notifications.route()` → `fcm.ring()` for `huddle` / `watch`; a phone that rang is
  skipped for the same Web Push.
- `MessagingService.kt` → `Ringer.kt` (CallStyle notification) → `RingActivity.kt`.
- `/.well-known/assetlinks.json` (server.py, `ANDROID_CERT_SHA256`) vouches for the
  signing key; without it Chrome shows a URL bar.

## Build

Needs JDK 17 and the Android SDK (both on opti: `~/jdk-17.0.2`, `~/android-sdk`).

    cd android
    JAVA_HOME=~/jdk-17.0.2 ./gradlew assembleRelease
    # → app/build/outputs/apk/release/app-release.apk

Bump `versionCode` in `app/build.gradle.kts` for every APK you hand out, or
phones refuse it as an update.

## Secrets (never in the repo)

`~/.crcmz-android/` on opti, back it up:

- `crcmz-upload.jks` + `keystore.pass`: the signing key. Lose it and every phone
  must uninstall before it can take a new build. SHA-256
  `9F:99:EC:CA:…:A9:29` (full value in server.py).
- `fcm-service-account.json`: Firebase project `crcmz-app`. The server reads it as
  `/data/fcm_service_account.json` (or `FCM_SERVICE_ACCOUNT_B64`).
