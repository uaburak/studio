#!/bin/sh
# Renders every approved screen (+ the attachments/mentions scene) from the
# real SwiftUI views with sample data, in light and dark, and captures each
# window with the window server (so Liquid Glass and materials are real),
# into apps/apple/docs/screenshots/{light,dark}/ at 1440x900.
#
#   apps/apple/scripts/render-screenshots.sh            # build first, then render
#   SKIP_BUILD=1 apps/apple/scripts/render-screenshots.sh
#
# Each scene opens briefly in a window on screen. `screencapture` needs the
# Screen Recording permission for the terminal that runs this script; without
# it macOS returns the desktop only. The XCTest renderer
# (StudioMacTests/ScreenshotTests) needs no permission and writes flattened
# offscreen renders to docs/screenshots/offscreen/.
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="$HERE/StudioMac/StudioMac.xcodeproj"
DERIVED="$HERE/StudioMac/build/DerivedData"
APP="$DERIVED/Build/Products/Debug/Studio.app/Contents/MacOS/Studio"
OUT="${STUDIO_SCREENSHOT_DIR:-$HERE/docs/screenshots}"
SCENES="01-sohbet-iki-panel 02-sohbet-sol-panel 03-sohbet-yalniz 04-baslangic 05-postlar 06-post-acik 07-ekler-ve-anma"

if [ -z "${SKIP_BUILD:-}" ]; then
  xcodebuild -project "$PROJECT" -scheme StudioMac -configuration Debug -derivedDataPath "$DERIVED" build -quiet
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for APPEARANCE in light dark; do
  mkdir -p "$OUT/$APPEARANCE"
  for SCENE in $SCENES; do
    rm -f "$TMP/id"
    if [ "$APPEARANCE" = dark ]; then
      "$APP" --show-scene "$SCENE" --dark --window-id-file "$TMP/id" >/dev/null 2>&1 &
    else
      "$APP" --show-scene "$SCENE" --window-id-file "$TMP/id" >/dev/null 2>&1 &
    fi
    PID=$!
    i=0
    while [ ! -s "$TMP/id" ] && [ $i -lt 120 ]; do sleep 0.25; i=$((i + 1)); done
    if [ ! -s "$TMP/id" ]; then
      echo "  $APPEARANCE/$SCENE: window did not appear" >&2
      kill "$PID" 2>/dev/null || true
      continue
    fi
    sleep 1
    screencapture -x -o -l"$(cat "$TMP/id")" "$TMP/shot.png"
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
    # Retina captures are 2x; the evidence is 1440x900.
    sips -z 900 1440 "$TMP/shot.png" --out "$OUT/$APPEARANCE/$SCENE.png" >/dev/null
    echo "  $APPEARANCE/$SCENE.png"
  done
done
echo "Wrote $OUT"
