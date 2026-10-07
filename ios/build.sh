#!/bin/bash
# Build and send a CRCMZ iOS build to TestFlight. Run on the Mac, from this folder:
#   ./build.sh            archive + upload to App Store Connect (TestFlight)
#   ./build.sh --ipa      archive + export an .ipa to build/out instead
# Needs ~/.crcmz-build (build keychain password) and the App Store Connect API key in
# ~/.appstoreconnect/private_keys. Bump CURRENT_PROJECT_VERSION in project.yml first.
set -euo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
KEY_ID=2Z72V6RA9Q
ISSUER=c6fedaac-bbca-41a4-94ed-8b3d2835321a
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$HOME/.appstoreconnect/private_keys/AuthKey_$KEY_ID.p8"
      -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER")
KC="$HOME/Library/Keychains/crcmz-build.keychain-db"

security unlock-keychain -p "$(cat ~/.crcmz-build/keychain.pass)" "$KC"
"$HOME/bin/xcodegen-app/bin/xcodegen" generate --quiet
rm -rf build/CRCMZ.xcarchive build/out
# Archive uses pre-installed manual profiles; -allowProvisioningUpdates is omitted here
# because it triggers dev-profile creation (requires registered devices) even for archives.
xcodebuild -project CRCMZ.xcodeproj -scheme CRCMZ -configuration Release -destination generic/platform=iOS \
  -archivePath build/CRCMZ.xcarchive archive OTHER_CODE_SIGN_FLAGS="--keychain $KC" \
  -authenticationKeyPath "$HOME/.appstoreconnect/private_keys/AuthKey_$KEY_ID.p8" \
  -authenticationKeyID "$KEY_ID" -authenticationKeyIssuerID "$ISSUER" -quiet

OPTS=ExportOptions.plist
if [ "${1:-}" = "--ipa" ]; then
  OPTS=build/ExportIPA.plist
  sed 's#<string>upload</string>#<string>export</string>#' ExportOptions.plist > "$OPTS"
fi
xcodebuild -exportArchive -archivePath build/CRCMZ.xcarchive -exportPath build/out -exportOptionsPlist "$OPTS" "${AUTH[@]}"
