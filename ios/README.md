# CRCMZ iOS app

`me.crcmz.app` (team CF6R3NUAP7): app.crcmz.me/app in a full-screen web view, plus what
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
    xcodebuild -project CRCMZ.xcodeproj -scheme CRCMZ -configuration Release \
      -destination generic/platform=iOS -archivePath build/CRCMZ.xcarchive archive \
      -allowProvisioningUpdates -authenticationKeyPath <ASC .p8> \
      -authenticationKeyID 2Z72V6RA9Q -authenticationKeyIssuerID c6fedaac-bbca-41a4-94ed-8b3d2835321a
    xcodebuild -exportArchive -archivePath build/CRCMZ.xcarchive -exportPath build/out \
      -exportOptionsPlist ExportOptions.plist -allowProvisioningUpdates (same key flags)

`ExportOptions.plist` uploads straight to App Store Connect (TestFlight). Bump
`CURRENT_PROJECT_VERSION` in project.yml for every upload.

## Secrets (never in the repo)

`~/.crcmz-ios/` on opti: `AuthKey_6J4DUKY9AR.p8` (APNs, the server reads it as
`APNS_KEY_B64`) and `AuthKey_2Z72V6RA9Q.p8` (App Store Connect API, for uploads).
