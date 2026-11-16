#!/bin/sh
# Launches the built app against a running API and captures its real window.
#
#   STUDIO_API_URL=http://127.0.0.1:8787 apps/apple/scripts/capture-live.sh
#
# Writes apps/apple/docs/screenshots/live/{sohbet,postlar,baslangic}.png (1440x900).
# Uses the app's own preferences domain for the server address only for this
# launch (-studio.serverURL argument), so nothing is changed permanently.
# Needs Screen Recording permission for the terminal (screencapture).
set -eu

HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HERE/StudioMac/build/DerivedData/Build/Products/Debug/Studio.app/Contents/MacOS/Studio"
API="${STUDIO_API_URL:-http://127.0.0.1:8787}"
OUT="${STUDIO_SCREENSHOT_DIR:-$HERE/docs/screenshots}/live"
APPEARANCE="${STUDIO_APPEARANCE:-light}"   # light | dark
mkdir -p "$OUT"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

shot() { # NAME ROUTE
  rm -f "$TMP/id"
  "$APP" -studio.serverURL "$API" -studio.appearance "$APPEARANCE" --route "$2" --window-id-file "$TMP/id" >/dev/null 2>&1 &
  PID=$!
  i=0
  while [ ! -s "$TMP/id" ] && [ $i -lt 120 ]; do sleep 0.25; i=$((i + 1)); done
  sleep 3
  screencapture -x -o -l"$(cat "$TMP/id")" "$TMP/shot.png"
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  sips -z 900 1440 "$TMP/shot.png" --out "$OUT/$1.png" >/dev/null
  echo "  live/$1.png"
}

shot sohbet "conversation:Kasım planı"
shot ekler "conversation:Hasat sezonu serisi"
shot postlar posts
shot baslangic newchat
