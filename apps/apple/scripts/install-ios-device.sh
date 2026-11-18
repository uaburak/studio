#!/bin/bash
# StudioIOS'u bağlı iPhone'a derleyip kurar (Xcode'da hesap gerekmeden).
#
# Xcode'da Apple hesabı oturumu yokken otomatik imza çalışmadığı için uygulamayı
# imzasız derler, sonra bu Mac'teki "Apple Development" sertifikası ve telefonu
# kapsayan joker ("*") geliştirme profiliyle elle imzalar.
#
# Kullanım: apps/apple/scripts/install-ios-device.sh [--launch] [cihaz-udid]
#   (udid verilmezse bağlı ilk iPhone kullanılır)
#   Varsayılan: yalnızca kurar, uygulamayı AÇMAZ (telefon kullanılırken araya girmesin).
#   --launch yalnızca telefonun sahibi açıkça istediğinde kullanılır.
#   Paket kimliği derlenen uygulamadan okunur (StudioIOS/Config: STUDIO_BUNDLE_ID).
set -euo pipefail
LAUNCH=0
if [ "${1:-}" = "--launch" ]; then LAUNCH=1; shift; fi
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
IDENTITY=$(security find-identity -v -p codesigning | grep "Apple Development" | head -1 | awk '{print $2}' || true)
[ -n "$IDENTITY" ] || { echo "Bu Mac'te geçerli bir \"Apple Development\" sertifikası yok. Xcode → Ayarlar → Hesaplar → Sertifikaları yönet → + Apple Development ile oluştur." >&2; exit 1; }

xcodebuild -project StudioIOS.xcodeproj -scheme StudioIOS -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath build/DeviceData CODE_SIGNING_ALLOWED=NO \
  ENABLE_DEBUG_DYLIB=NO build -quiet
APP=build/DeviceData/Build/Products/Debug-iphoneos/Studio.app
cp "$PROFILE" "$APP/embedded.mobileprovision"
BUNDLE_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Info.plist")

# Entitlements: the app's own Keychain group plus the group it shares with its extensions
# (`<team>.<bundle id>.shared`, N20/N22). A wildcard profile cannot carry an App Group, so
# the share sheet uploads only while it is open and the widget caches in its own folder
# (apps/apple/README.md, STUDIO_SHARING = KEYCHAIN).
entitlements() { # file, bundle id, keychain groups...
  out="$1"; id="$2"; shift 2
  groups=""
  for g in "$@"; do groups="$groups<string>$g</string>"; done
  cat > "$out" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>application-identifier</key><string>$TEAM.$id</string>
<key>com.apple.developer.team-identifier</key><string>$TEAM</string>
<key>get-task-allow</key><true/>
<key>keychain-access-groups</key><array>$groups</array>
</dict></plist>
EOF
}
ENT=$(mktemp -t studio-ent).plist
# Every nested binary must be signed too (frameworks, and any *.dylib next to the
# executable, e.g. Xcode's debug dylib), or dyld refuses to load it at launch.
if [ -d "$APP/Frameworks" ]; then
  for fw in "$APP"/Frameworks/*; do codesign -f -s "$IDENTITY" "$fw"; done
fi
for lib in "$APP"/*.dylib; do [ -e "$lib" ] && codesign -f -s "$IDENTITY" "$lib"; done
# The share extension and the widget (PlugIns/*.appex), inside out.
if [ -d "$APP/PlugIns" ]; then
  for appex in "$APP"/PlugIns/*.appex; do
    [ -e "$appex" ] || continue
    cp "$PROFILE" "$appex/embedded.mobileprovision"
    for lib in "$appex"/*.dylib; do [ -e "$lib" ] && codesign -f -s "$IDENTITY" "$lib"; done
    APPEX_ID=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$appex/Info.plist")
    entitlements "$ENT" "$APPEX_ID" "$TEAM.$BUNDLE_ID.shared"
    codesign -f -s "$IDENTITY" --entitlements "$ENT" "$appex"
  done
fi
entitlements "$ENT" "$BUNDLE_ID" "$TEAM.$BUNDLE_ID" "$TEAM.$BUNDLE_ID.shared"
codesign -f -s "$IDENTITY" --entitlements "$ENT" "$APP"
rm -f "$ENT"

codesign --verify --deep --strict "$APP"
xcrun devicectl device install app --device "$DEVICE" "$APP"
if [ "$LAUNCH" = 1 ]; then
  xcrun devicectl device process launch --device "$DEVICE" --terminate-existing "$BUNDLE_ID" >/dev/null
  echo "Kuruldu ve açıldı: $BUNDLE_ID → $DEVICE"
else
  echo "Kuruldu (açılmadı): $BUNDLE_ID → $DEVICE"
fi
