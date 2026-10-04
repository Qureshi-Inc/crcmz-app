# CRCMZ iOS app

`me.crcmz.app`: app.crcmz.me/app in a full-screen web view, plus what
a web page can't do on an iPhone:

- **Notifications** through APNs (`apns.py`): the web view gets no Web Push.
- **Rings**: Huddle / Watch Party / Rally on the system call screen (CallKit), woken by a
  VoIP push (PushKit). Answer opens the page; the system call then ends.
- **Links**: app.crcmz.me/app links open the app (applinks), and passkeys made on
  app.crcmz.me work (webcredentials). Both read `/.well-known/apple-app-site-association`.

Pages, sign-in, calls and the party are the website, so a site deploy updates the app.

## How the pieces connect

- `WebController.swift` loads `/app?crcmz_app=ios`. Push and PushKit tokens go to the
  signed-in page through `window.__crcmzNative(token, platform)` (frontend/src/lib/native.ts)
  → `/api/push/native` as `ios` / `ios-voip`.
- `notifications.route()` → `apns.alert()` for every category (iPhones in the app), and for
  huddle / watch → `apns.ring()` (VoIP) instead.

## Build (on the Mac)

    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
    xcodegen generate
    ./build.sh            # archive, sign and upload to TestFlight

`build.sh` needs the App Store Connect API key and the signing keychain on the build Mac.
Bump `CURRENT_PROJECT_VERSION` in project.yml for every upload. Where the keys live and how
builds reach testers is in the private operations handbook, not here.
