#!/bin/sh
# Captures real responses from a running LOCAL API (seeded with
# seed-local-api.sh) into StudioKit's test fixtures. Read-only, except one
# deliberately failing request per error shape.
#
#   STUDIO_API_URL=http://127.0.0.1:8787 STUDIO_OWNER_SECRET=<value> apps/apple/scripts/capture-fixtures.sh
#
# The API accepts the owner's requests only with its owner secret (X-Studio-Owner): start it with
# STUDIO_OWNER_SECRET in apps/api/.dev.vars and pass the same value here as STUDIO_OWNER_SECRET.
# Run it again when packages/contract changes; the decoding tests then show
# what the Swift models must follow. Needs curl, jq and node (for the
# WebSocket frames).
set -eu

API="${STUDIO_API_URL:-http://127.0.0.1:8787}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../StudioKit/Tests/StudioKitTests/Fixtures"
mkdir -p "$OUT"

# Every request carries the owner secret (apps/api/src/middleware/access.ts).
curl() { command curl -H "X-Studio-Owner: ${STUDIO_OWNER_SECRET:-}" "$@"; }

get() { curl -fsS "$API$1" | jq . > "$OUT/$2.json"; echo "  $2.json"; }
fail() { curl -sS -X "$1" "$API$2" -H 'content-type: application/json' ${3:+-d "$3"} | jq . > "$OUT/$4.json"; echo "  $4.json"; }

echo "Capturing from $API into $OUT"
MTM=$(curl -fsS "$API/api/brands?limit=100" | jq -r '.items[] | select(.slug == "mtm-agro") | .id')
[ -n "$MTM" ] || { echo "Seed the API first (seed-local-api.sh)." >&2; exit 1; }

get /api/health health
get "/api/brands?limit=100" brand-list
get "/api/social-accounts?brandId=$MTM&limit=100" social-account-list
get "/api/contents?brandId=$MTM&limit=100" content-list
CID=$(curl -fsS "$API/api/contents?brandId=$MTM&limit=100" | jq -r '[.items[] | select(.title == "Venta Borinc")][0].id')
get "/api/contents/$CID" content
get "/api/contents/$CID/versions/1" content-version
get "/api/plans?brandId=$MTM&limit=100" plan-list
get "/api/schedules?brandId=$MTM&limit=100" schedule-list
get "/api/jobs?limit=20" job-list
get /api/workers/presence presence
get "/api/conversations?limit=100" conversation-list
KASIM=$(curl -fsS "$API/api/conversations?limit=100" | jq -r '[.items[] | select(.title == "Kasım planı")][0].id')
HASAT=$(curl -fsS "$API/api/conversations?limit=100" | jq -r '[.items[] | select(.title == "Hasat sezonu serisi")][0].id')
get "/api/conversations/$KASIM/messages?limit=50" message-list
get "/api/conversations/$HASAT/messages?limit=50" message-list-attachments
get "/api/conversations/$HASAT/aliases" alias-list
get "/api/conversations/$KASIM/runs" run-list
ASSET=$(curl -fsS "$API/api/conversations/$HASAT/aliases" | jq -r '.items[0].assetId')
get "/api/assets/$ASSET" asset

fail GET /api/contents/does-not-exist "" error-not-found
fail POST "/api/contents/$CID/approve" '{"hash":"0000000000000000000000000000000000000000000000000000000000000000"}' error-hash-mismatch
fail POST /api/brands '{"name":""}' error-validation

node "$HERE/capture-stream.mjs" "$API" "$KASIM" "$OUT"
echo "Done."
