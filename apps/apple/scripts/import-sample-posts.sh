#!/bin/sh
# Loads a folder of finished post pictures into a brand of the RUNNING local Studio, as rendered
# drafts: the first two become Reels, the next two stories, the rest single posts.
#
#   STUDIO_OWNER_SECRET=<value> apps/apple/scripts/import-sample-posts.sh "MTM Agro" "/path/to/folder"
#   STUDIO_OWNER_SECRET=<value> apps/apple/scripts/import-sample-posts.sh "MTM Agro" --repair
#
# --repair fixes posts an earlier run of this script made with `src="asset:<id>"` images, which
# the Mac's renderer cannot resolve (a re-render of them came out white): each gets a new version
# whose picture is `/media/<id>.<ext>` (the render contract), shown as the original image.
#
# STUDIO_API_URL defaults to http://127.0.0.1:8790 (the Mac app's local API). Only local APIs.
# Needs curl, jq and sips. The owner secret is the X-Studio-Owner value of that Studio.
set -eu

BRAND_NAME="${1:?brand name}"
FOLDER="${2:?folder of pictures, or --repair}"
API="${STUDIO_API_URL:-http://127.0.0.1:8790}"
: "${STUDIO_OWNER_SECRET:?set STUDIO_OWNER_SECRET}"

case "$API" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "Refusing $API: only local APIs." >&2; exit 1 ;;
esac

req() { # METHOD PATH [JSON]
  if [ $# -ge 3 ]; then
    curl -fsS -X "$1" "$API$2" -H "X-Studio-Owner: $STUDIO_OWNER_SECRET" -H 'content-type: application/json' -d "$3"
  else
    curl -fsS -X "$1" "$API$2" -H "X-Studio-Owner: $STUDIO_OWNER_SECRET"
  fi
}

BRAND=$(req GET "/api/brands?limit=100" | jq -r --arg n "$BRAND_NAME" '.items[] | select(.name == $n) | .id' | head -1)
[ -n "$BRAND" ] || { echo "No brand named $BRAND_NAME" >&2; exit 1; }
echo "Brand $BRAND_NAME: $BRAND"

# One picture filling the slide, in the render contract's form (`/media/<assetId><ext>`).
slide_html() { # ASSET EXT WIDTH HEIGHT
  printf '<!doctype html><html><body style="margin:0"><img data-layer="photo" src="/media/%s%s" style="display:block;width:%spx;height:%spx;object-fit:cover"></body></html>' "$1" "$2" "$3" "$4"
}

add_version() { # CONTENT ASSET EXT WIDTH HEIGHT NOTE
  html=$(slide_html "$2" "$3" "$4" "$5")
  req POST "/api/contents/$1/versions" "$(jq -nc --arg html "$html" --argjson w "$4" --argjson h "$5" --arg a "$2" --arg note "$6" \
    '{origin: "manual_edit", slides: [{html: $html, width: $w, height: $h}], renderedAssetIds: [$a], note: $note}')" >/dev/null
}

if [ "$FOLDER" = "--repair" ]; then
  n=0
  for content in $(req GET "/api/contents?brandId=$BRAND&limit=100" | jq -r '.items[] | select(.currentVersion != null) | .id'); do
    version=$(req GET "/api/contents/$content" | jq -r '.currentVersion.version')
    slide=$(req GET "/api/contents/$content/versions/$version" | jq -c '.slides[0]')
    asset=$(printf '%s' "$slide" | jq -r '.html' | sed -n 's/.*src="asset:\([^"]*\)".*/\1/p')
    [ -n "$asset" ] || continue
    w=$(printf '%s' "$slide" | jq -r '.width'); h=$(printf '%s' "$slide" | jq -r '.height')
    mime=$(req GET "/api/assets/$asset" | jq -r '.mimeType')
    case "$mime" in image/png) ext=.png ;; *) ext=.jpg ;; esac
    add_version "$content" "$asset" "$ext" "$w" "$h" "Görsel yolu düzeltildi"
    n=$((n + 1))
    echo "repaired $content"
  done
  echo "Done: $n repaired."
  exit 0
fi

i=0
for file in "$FOLDER"/*.jpg "$FOLDER"/*.jpeg "$FOLDER"/*.png; do
  [ -f "$file" ] || continue
  i=$((i + 1))
  name=$(basename "$file")
  w=$(sips -g pixelWidth "$file" | awk '/pixelWidth/ {print $2}')
  h=$(sips -g pixelHeight "$file" | awk '/pixelHeight/ {print $2}')
  case "$name" in *.png) mime=image/png; ext=.png ;; *) mime=image/jpeg; ext=.jpg ;; esac
  if [ $i -le 2 ]; then type=reel; label="Reels $i"
  elif [ $i -le 4 ]; then type=story; label="Hikâye $((i - 2))"
  else type=post; label="Gönderi $((i - 4))"; fi

  asset=$(curl -fsS -X POST "$API/api/assets" -H "X-Studio-Owner: $STUDIO_OWNER_SECRET" \
    -F "brandId=$BRAND" -F kind=image -F source=generated -F "width=$w" -F "height=$h" \
    -F "file=@$file;type=$mime" | jq -r .id)
  content=$(req POST /api/contents "$(jq -nc --arg b "$BRAND" --arg t "$type" --arg title "$label" \
    '{brandId: $b, type: $t, title: $title, targetPlatforms: ["instagram"]}')" | jq -r .id)
  add_version "$content" "$asset" "$ext" "$w" "$h" "Örnek görselden"
  echo "$type  $label  ← $name"
done
echo "Done: $i items."
