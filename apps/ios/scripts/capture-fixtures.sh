#!/bin/sh
# Captures real responses from a running local API into StudioTests/Fixtures.
#
#   pnpm --filter @studio/api dev          # in another terminal
#   apps/ios/scripts/capture-fixtures.sh   # optional: STUDIO_API=http://127.0.0.1:8787
#
# Creates a throwaway brand ("iOS fixture …") with one social account, two
# contents, a version, an approval, a schedule and a few jobs, records every
# response, then archives the brand so it stays out of brand pickers.
# Needs curl, jq and node (for the WebSocket frames).
set -eu

API="${STUDIO_API:-http://127.0.0.1:8787}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../StudioTests/Fixtures"
mkdir -p "$OUT"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# req METHOD PATH [BODY] -> prints body; fails on transport errors only.
req() {
  if [ $# -ge 3 ]; then
    curl -sS -X "$1" "$API$2" -H 'content-type: application/json' --data-binary "$3"
  else
    curl -sS -X "$1" "$API$2"
  fi
}
save() { jq . > "$OUT/$1"; echo "  $1"; }

echo "Capturing from $API into $OUT"
curl -sS "$API/api/openapi.json" | save openapi.json
req GET /api/health | save health.json

SUFFIX="$(date +%s)"
BRAND=$(req POST /api/brands "{\"name\":\"iOS fixture $SUFFIX\"}")
printf '%s\n' "$BRAND" | save brand.json
B=$(printf '%s\n' "$BRAND" | jq -r .id)
req GET "/api/brands?limit=1" | save brand-list.json

ACCOUNT=$(req POST /api/social-accounts "{\"brandId\":\"$B\",\"platform\":\"instagram\",\"handle\":\"@iosfixture\"}")
printf '%s\n' "$ACCOUNT" | save social-account.json
A=$(printf '%s\n' "$ACCOUNT" | jq -r .id)
req GET "/api/social-accounts?brandId=$B" | save social-account-list.json

CONTENT=$(req POST /api/contents "{\"brandId\":\"$B\",\"type\":\"carousel\",\"title\":\"Hasat sezonu\",\"brief\":\"İki slaytlık carousel: güçlü başlık, sonra bayilere çağrı.\",\"targetPlatforms\":[\"instagram\"]}")
printf '%s\n' "$CONTENT" | save content-created.json
C=$(printf '%s\n' "$CONTENT" | jq -r .id)

JOB=$(req POST /api/jobs "{\"type\":\"content.generate\",\"contentId\":\"$C\",\"payload\":{\"brief\":\"İki slaytlık carousel\",\"title\":\"Hasat sezonu\",\"type\":\"carousel\",\"targetPlatforms\":[\"instagram\"],\"assetIds\":[]}}")
printf '%s\n' "$JOB" | save job-created.json
J=$(printf '%s\n' "$JOB" | jq -r .id)
req GET "/api/jobs?brandId=$B" | save job-list.json
req GET /api/workers/presence | save presence.json
req POST "/api/jobs/$J/cancel" | save job-cancelled.json
req POST "/api/jobs/$J/cancel" | save error-invalid-transition.json

# 1x1 PNG
printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > "$TMP/pixel.png"
ASSET=$(curl -sS -X POST "$API/api/assets" -F "brandId=$B" -F "width=1" -F "height=1" -F "file=@$TMP/pixel.png;type=image/png")
printf '%s\n' "$ASSET" | save asset.json
AS=$(printf '%s\n' "$ASSET" | jq -r .id)
printf 'not a png' > "$TMP/fake.png"
curl -sS -X POST "$API/api/assets" -F "brandId=$B" -F "file=@$TMP/fake.png;type=image/png" | save error-unsupported-media.json

# Slide HTML exercises the hash canonicalisation: quotes, backslash, slash,
# newline, tab, Turkish letters, emoji and a control character.
cat > "$TMP/version.json" <<'JSON'
{"origin":"generated","note":"İlk sürüm","slides":[
 {"html":"<!doctype html><html><head><style>h1{font:700 96px/1 \"Inter\"}</style></head><body><h1>Hasat zamanı — çiftçi ğ ü ş ı ö ç İ</h1>\n\t<p class=\"a\\b\">50% indirim / 🌾 \u0001</p><script>/* </script> */</script></body></html>","width":1080,"height":1350},
 {"html":"<html><body><p>Bayinize sorun.</p></body></html>","width":1080,"height":1350}
],"renderedAssetIds":["ASSET_ID",null]}
JSON
sed "s/ASSET_ID/$AS/" "$TMP/version.json" > "$TMP/version2.json"
VERSION=$(req POST "/api/contents/$C/versions" "$(cat "$TMP/version2.json")")
printf '%s\n' "$VERSION" | save version.json
H=$(printf '%s\n' "$VERSION" | jq -r .contentHash)
req GET "/api/contents/$C/versions" | save version-list.json
req GET "/api/contents/$C" | save content-with-version.json
req POST "/api/contents/$C/approve" '{"hash":"0000000000000000000000000000000000000000000000000000000000000000"}' | save error-hash-mismatch.json
req POST "/api/contents/$C/approve" "{\"hash\":\"$H\"}" | save content-approved.json

WHEN=$(node -e 'console.log(new Date(Date.now()+2*86400e3).toISOString())')
SCHEDULE=$(req POST /api/schedules "{\"contentId\":\"$C\",\"socialAccountId\":\"$A\",\"scheduledAt\":\"$WHEN\"}")
printf '%s\n' "$SCHEDULE" | save schedule.json
S=$(printf '%s\n' "$SCHEDULE" | jq -r .id)
req GET "/api/schedules?brandId=$B" | save schedule-list.json
req GET "/api/contents/$C" | save content-scheduled.json
req POST "/api/schedules/$S/cancel" | save schedule-cancelled.json
req GET "/api/contents?brandId=$B" | save content-list.json

req GET /api/contents/does-not-exist | save error-not-found.json
req POST /api/contents '{}' | save error-validation.json

# WebSocket frames: snapshot, a job.updated caused by a new job, and a pong.
node "$HERE/capture-stream.mjs" "$API" "$B" "$C" "$OUT"

req PATCH "/api/brands/$B" '{"status":"archived"}' > /dev/null
echo "Done. Fixture brand $B archived."
