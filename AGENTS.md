# CRCMZ app: notes for AI agents

One product, three surfaces. Read this before changing anything a user sees.

| Surface | Code | How it updates |
|---|---|---|
| Web app + API (app.crcmz.me) | `server.py` + modules, `frontend/` (React, Vite) | Push to `main`, then **trigger a Coolify deploy** (a push alone deploys nothing) |
| iPhone app (TestFlight) | `ios/` (Swift, XcodeGen) | Only native changes need a build; it loads the live site |
| Android app (GitHub Releases APK) | `android/` (Kotlin) | Only native changes need a build; it loads the live site |

Both phone apps are web views around app.crcmz.me/app with native parts where the web
can't keep up. **Most features are web-only**: ship the site and both apps have it.
Rebuild an app only when you change its native code.

## The native split (same on both phones)

The page talks to the apps in one way: `window.webkit.messageHandlers.<name>.postMessage(m)`
(real on iOS; on Android a document-start script provides it). The apps answer through
`window.__crcmz*` functions. Outside the apps none of this exists, so every hook checks
first (`nativeShell()`, `nativeCalls()`, `nativeAudio()`).

| Feature | Page side | iOS | Android |
|---|---|---|---|
| Tab bar + More | `frontend/src/lib/nativeShell.ts` (`crcmzShell`, `__crcmzGo`) | `Shell.swift` | `Shell.kt` |
| Huddle / Watch Party calls (LiveKit), PiP | `frontend/src/lib/nativeCall.ts` (`crcmzCall`, `__crcmzCallEnded`) | `NativeCall.swift`, `CallOverlay.swift` | `NativeCall.kt`, `CallOverlay.kt`, `CallService.kt` |
| Slap player (screen off, lock screen, CarPlay / Android Auto) | `frontend/src/lib/nativeAudio.ts` (`crcmzAudio`, `__crcmzAudio`) | `NativeAudio.swift` | `NativeAudio.kt`, `PlaybackService.kt` |
| Push tokens | `frontend/src/lib/native.ts` → `/api/push/native` | `Push.swift`, `Calls.swift` (PushKit + CallKit rings) | `MessagingService.kt`, `Ringer.kt` |
| Host (web view, links, uploads, permissions) | — | `WebController.swift` | `LauncherActivity.kt` |

Rules that keep the three in step:

- **A change to a message's shape changes all three**: the `.ts` file and both apps.
  Add fields; never rename or remove one an installed app still sends or reads.
- **New tab or More page**: add it to `frontend/src/app/nav.ts`. Both native bars draw
  whatever the page sends. A new icon needs an SF Symbol in `Shell.swift` and a vector
  drawable in `android/app/src/main/res/drawable/` (convert from
  `frontend/src/components/Icon.tsx`).
- **Notifications**: send through `notifications.route()` only. It reaches Web Push,
  iPhones (`apns.py`: platforms `ios`, `ios-voip`) and Android (`fcm.py`: `android` is
  the old 1.x app, `android-app` is 2.x and gets every alert). Only `huddle` / `watch`
  ring, and only from a manual Ring / Rally.
- Camera, mic and Slap inside the apps are native: don't add a web `getUserMedia` or
  `<audio>` path that the apps would also run.

## Shipping

**Web:** `git fetch && git pull --rebase` (another AI also pushes here; keep its commits,
never force-push), push `main`, check the Coolify queue is empty, then queue **one** deploy
for app 24:

    docker exec coolify php artisan tinker --execute='$a=App\Models\Application::find(24); $u=(string) new Visus\Cuid2\Cuid2(); queue_application_deployment(application:$a, deployment_uuid:$u, commit:"HEAD", is_api:true); echo $u;'

Then check `SOURCE_COMMIT` on the container and `GET /health` on :3021.

**iPhone** (`ios/README.md`): bump `CURRENT_PROJECT_VERSION` in `ios/project.yml`, rsync
`ios/` to the MacBook (`moizqureshi@100.65.68.108`, key `~/.ssh/macbook_automation`,
folder `~/crcmz-ios`), run `./build.sh` there (it uploads to TestFlight). Then, through
`~/.crcmz-ios/asc.py`, add the build to the **CRCMZ Squad** group and submit it for Beta
App Review. Simulator checks: a Debug build with `-crcmzShellDemo YES` or
`-crcmzAudioDemo …`, run with `xcrun simctl` in the background (it's the owner's Mac;
don't bring the Simulator to the front).

**Android** (`android/README.md`): bump `versionCode` and `versionName` in
`android/app/build.gradle.kts`, then
`JAVA_HOME=~/jdk-17.0.2 ANDROID_HOME=~/android-sdk ./gradlew assembleRelease`. Test on
the Mac's emulator (AVD `slap_test`, `adb` works over SSH), then publish a GitHub release
tagged `android-vX.Y.Z` with the APK attached. "Get the app" links to the latest release.

## Never

- Print or commit secrets: signing keys and passwords in `~/.crcmz-android`,
  `~/.crcmz-ios`, `~/.crcmz-build`, Coolify env values, tokens. Read them in scripts, pipe
  them over stdin.
- Add app-development@deentek.com (Fahad) to TestFlight.
- Touch the auth / passkey code.
- Let tests reach production (no real pushes, rings or posts).

## Tests

- Server: `tests/run-all.sh <suite …>` in the `crcmz-app:test` image (`docker build -t crcmz-app:test .`).
- Web: `npx tsc -b`, then `node tests/smoke.mjs` from `frontend/` against
  `CRCMZ_BACKEND=http://127.0.0.1:3021 npx vite --port 5199`.
- New data store or assistant tool: follow the `crcmz-mcp-tool` skill.
