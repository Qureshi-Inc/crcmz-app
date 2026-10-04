# CRCMZ Android app

`me.crcmz.app` 2.x: app.crcmz.me/app in a web view, with native parts where the web
can't keep up on a phone. It's the same split as the iOS app (`ios/`), and the page talks
to both the same way: `window.webkit.messageHandlers.<name>.postMessage(m)`.

| Native part | Kotlin | Page side |
|---|---|---|
| Tab bar + More sheet | `Shell.kt` | `frontend/src/lib/nativeShell.ts` |
| Huddle / Watch Party calls (LiveKit), mini panel, picture in picture, background (`CallService`) | `NativeCall.kt`, `CallOverlay.kt`, `CallService.kt` | `frontend/src/lib/nativeCall.ts` |
| Slap player (Media3): screen off, lock screen, media notification, headphones, Android Auto | `NativeAudio.kt`, `PlaybackService.kt` | `frontend/src/lib/nativeAudio.ts` |
| Notifications (every category) and rings, both FCM | `MessagingService.kt`, `Ringer.kt`, `RingActivity.kt` | `frontend/src/lib/native.ts` |

A site deploy updates every page; rebuild only for changes in this folder.

## How the pieces connect

- `LauncherActivity.kt` hosts the web view (app.crcmz.me and auth.crcmz.me only; other
  links open outside). A script at document start defines `window.webkit.messageHandlers`
  and forwards to a WebMessageListener only `https://app.crcmz.me` can reach. The app
  answers with `window.__crcmzGo`, `__crcmzCallEnded`, `__crcmzAudio`.
- First launch: notification permission, the FCM token, then the two ring settings
  (full-screen notifications, no battery limits), each asked once. The page opens with
  `?crcmz_app=android-app&crcmz_fcm=<token>`; `native.ts` registers the phone as
  platform `android-app`.
- A web view gets no Web Push, so `notifications.route()` sends every alert to
  `android-app` phones through `fcm.alert()`, and rings through `fcm.ring()`. A phone that
  upgrades from 1.x has its old Chrome Web Push subscription removed, so nothing arrives
  twice.
- Passkeys (RP `crcmz.me`) work in the web view through the phone's credential manager:
  `crcmz.me/.well-known/assetlinks.json` (repo `crcmz-coming-soon`) and
  `app.crcmz.me/.well-known/assetlinks.json` (server.py) list this app's signing key
  with `get_login_creds`.
- Share → CRCMZ: a shared link opens `/app/share` (a song goes to Slap, a film to Movies, a video to the Watch Party); a video from Photos opens Clips' Send a video. Shortcuts
  (long-press the icon): Watch Party, Movies, Slap, Huddle, Clips.
- Android Auto shows Slap's Now Playing. Sideloaded apps only appear there with Android
  Auto's developer setting "Unknown sources" on.

1.x (a Trusted Web Activity, Chrome full screen) is in git history before 2.0.0.

## Build

Needs JDK 17 and the Android SDK.

    cd android
    ./gradlew assembleRelease
    # → app/build/outputs/apk/release/app-release.apk

Bump `versionCode` in `app/build.gradle.kts` for every APK you hand out, or
phones refuse it as an update. Release builds are signed with the CRCMZ upload key, which
is never in the repo (see the private operations handbook).
