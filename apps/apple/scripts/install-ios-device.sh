#!/bin/bash
# StudioIOS'u bağlı iPhone'a derleyip kurar (Xcode'da hesap gerekmeden).
#
# Xcode'da Apple hesabı oturumu yokken otomatik imza çalışmadığı için uygulamayı
# imzasız derler, sonra bu Mac'teki "Apple Development" sertifikası ve telefonu
# kapsayan joker ("*") geliştirme profiliyle elle imzalar.
#
# Kullanım: apps/apple/scripts/install-ios-device.sh [cihaz-udid]
#   (udid verilmezse bağlı ilk iPhone kullanılır)
set -euo pipefail
cd "$(dirname "$0")/../StudioIOS"

DEVICE="${1:-$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ && /connected|available/ {for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) {print $i; exit}}')}"
[ -n "$DEVICE" ] || { echo "Bağlı iPhone bulunamadı." >&2; exit 1; }

PROFILE=""
for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/"*; do
  id=$(security cms -D -i "$f" 2>/dev/null | plutil -extract Entitlements.application-identifier raw - 2>/dev/null | sed -E 's/^[A-Z0-9]+\.//') || continue
  if [ "$id" = "*" ] && security cms -D -i "$f" 2>/dev/null | grep -q "$DEVICE"; then PROFILE="$f"; fi
done
[ -n "$PROFILE" ] || { echo "Bu iPhone'u kapsayan joker geliştirme profili yok. Xcode'da bir kez hesabınla Run et." >&2; exit 1; }
TEAM=$(security cms -D -i "$PROFILE" | plutil -extract TeamIdentifier.0 raw -)
IDENTITY=$(security find-identity -v -p codesigning | grep "Apple Development" | head -1 | awk '{print $2}')

xcodebuild -project StudioIOS.xcodeproj -scheme StudioIOS -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath build/DeviceData CODE_SIGNING_ALLOWED=NO build -quiet
APP=build/DeviceData/Build/Products/Debug-iphoneos/Studio.app
cp "$PROFILE" "$APP/embedded.mobileprovision"

ENT=$(mktemp -t studio-ent).plist
cat > "$ENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>$TEAM.net.burakkoc.studio.ios</string>
<key>com.apple.developer.team-identifier</key><string>$TEAM</string>
<key>get-task-allow</key><true/>
<key>keychain-access-groups</key><array><string>$TEAM.net.burakkoc.studio.ios</string></array>
</dict></plist>
EOF
if [ -d "$APP/Frameworks" ]; then
  for fw in "$APP"/Frameworks/*; do codesign -f -s "$IDENTITY" "$fw"; done
fi
codesign -f -s "$IDENTITY" --entitlements "$ENT" "$APP"
rm -f "$ENT"

xcrun devicectl device install app --device "$DEVICE" "$APP"
echo "Kuruldu: net.burakkoc.studio.ios → $DEVICE"
