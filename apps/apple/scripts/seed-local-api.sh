#!/bin/sh
# Fills a LOCAL Studio API with realistic Turkish test data (MTM Agro, posts,
# conversations) so the Mac app can be tried against the real API.
#
#   STUDIO_API_URL=http://127.0.0.1:8787 apps/apple/scripts/seed-local-api.sh
#
# Optional: STUDIO_SEED_WORKER_TOKEN = the WORKER_TOKEN of that API instance.
# With it the script also writes assistant replies through the worker turn API
# (/api/worker/runs/...), i.e. it plays the Mac worker's chat agent, which does
# not exist yet. Without it, conversations only get the user messages (their
# runs stay queued, exactly as with the real backend today).
#
# Never point this at a deployed API. It refuses to run twice (brand slug
# `mtm-agro` already present). Needs curl and jq.
set -eu

API="${STUDIO_API_URL:-http://127.0.0.1:8787}"
TOKEN="${STUDIO_SEED_WORKER_TOKEN:-}"

case "$API" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "Refusing to seed $API: only local APIs (127.0.0.1 / localhost)." >&2; exit 1 ;;
esac

req() { # METHOD PATH [JSON]
  if [ $# -ge 3 ]; then
    curl -fsS -X "$1" "$API$2" -H 'content-type: application/json' -d "$3"
  else
    curl -fsS -X "$1" "$API$2"
  fi
}
worker() { # METHOD PATH JSON
  curl -fsS -X "$1" "$API$2" -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" -d "$3"
}

if req GET "/api/brands?limit=100" | jq -e '.items[] | select(.slug == "mtm-agro")' >/dev/null; then
  echo "MTM Agro already exists in $API; nothing to do." >&2
  exit 0
fi

echo "Seeding $API"

# --- brands and accounts -------------------------------------------------------------
MTM=$(req POST /api/brands '{"name":"MTM Agro","slug":"mtm-agro"}' | jq -r .id)
KOC=$(req POST /api/brands '{"name":"Koç Chords","slug":"koc-chords"}' | jq -r .id)
FINVO=$(req POST /api/brands '{"name":"Finvo"}' | jq -r .id)
BURAK=$(req POST /api/brands '{"name":"burakkoc.net","slug":"burakkoc-net"}' | jq -r .id)

IG=$(req POST /api/social-accounts "{\"brandId\":\"$MTM\",\"platform\":\"instagram\",\"handle\":\"mtmagro\",\"externalId\":\"17841400000000001\",\"status\":\"connected\"}" | jq -r .id)
req POST /api/social-accounts "{\"brandId\":\"$MTM\",\"platform\":\"facebook\",\"handle\":\"MTM Agro\",\"externalId\":\"102200000000001\",\"status\":\"connected\"}" >/dev/null
req POST /api/social-accounts "{\"brandId\":\"$MTM\",\"platform\":\"linkedin\",\"handle\":\"MTM Agro\",\"status\":\"pending\"}" >/dev/null
req POST /api/social-accounts "{\"brandId\":\"$KOC\",\"platform\":\"instagram\",\"handle\":\"kocchords\",\"status\":\"connected\"}" >/dev/null

# --- plan items (Kasım 2026) ----------------------------------------------------------
ITEMS='[
 {"date":"2026-11-04","platforms":["instagram","facebook"],"contentType":"post","title":"Venta Borinc","pillar":"Yeni ürün","imageSlot":"user_upload","brief":"Venta Borinc ilk kez tanıtılıyor; bor ve çinkonun birlikte etkisi.","imageBrief":"Ürün torbasının tarlada dikey fotoğrafı"},
 {"date":"2026-11-07","platforms":["instagram","facebook"],"contentType":"post","title":"Doğru saklama rehberi","pillar":"Rehber","imageSlot":"none","brief":"Gübrenin kışın nasıl saklanacağına dair üç adım."},
 {"date":"2026-11-11","platforms":["instagram","facebook"],"contentType":"post","title":"Bor ve çinko","pillar":"Bilgi","imageSlot":"none","brief":"İki besin elementinin birlikte alımı."},
 {"date":"2026-11-14","platforms":["instagram","facebook"],"contentType":"post","title":"Bayi buluşması","pillar":"Kampanya","imageSlot":"user_upload","brief":"Bayi buluşmasının tarih ve yeri.","imageBrief":"Geçen yılki buluşmadan bir kare"},
 {"date":"2026-11-18","platforms":["instagram","facebook"],"contentType":"post","title":"Uygulama zamanı","pillar":"Bilgi","imageSlot":"none","brief":"Hangi dönemde, hangi dozda uygulanır."},
 {"date":"2026-11-21","platforms":["instagram","facebook"],"contentType":"post","title":"Tarladan","pillar":"Ürün","imageSlot":"user_upload","brief":"Üreticinin tarladan çektiği fotoğrafla sonuç.","imageBrief":"Üreticinin tarla fotoğrafı"},
 {"date":"2026-11-25","platforms":["instagram","facebook"],"contentType":"post","title":"Soru cevap","pillar":"Bilgi","imageSlot":"none","brief":"En sık gelen üç soru."},
 {"date":"2026-11-28","platforms":["instagram","facebook"],"contentType":"post","title":"Ay sonu","pillar":"Özet","imageSlot":"none","brief":"Kasım ayının kısa özeti."},
 {"date":"2026-11-29","platforms":["instagram","facebook"],"contentType":"post","title":"Kış hazırlığı","pillar":"Rehber","imageSlot":"user_upload","brief":"Toprağı kışa hazırlamak.","imageBrief":"Kışa hazırlanan tarla"},
 {"date":"2026-11-30","platforms":["instagram","facebook"],"contentType":"post","title":"Bayi haritası","pillar":"Kampanya","imageSlot":"user_upload","brief":"Bölgedeki bayiler.","imageBrief":"Bayi önünden bir kare"},
 {"date":"2026-11-30","platforms":["instagram","facebook"],"contentType":"post","title":"Müşteri hikâyesi","pillar":"Ürün","imageSlot":"user_upload","brief":"Bir üreticinin deneyimi.","imageBrief":"Üreticinin portresi"},
 {"date":"2026-11-30","platforms":["instagram","facebook"],"contentType":"post","title":"Sezon kapanışı","pillar":"Özet","imageSlot":"none","brief":"Sezonun kapanışı ve teşekkür."}
]'

# --- conversations --------------------------------------------------------------------
conversation() { # BRAND TITLE
  req POST /api/conversations "{\"brandId\":\"$1\",\"title\":\"$2\"}" | jq -r .id
}
user_message() { # CONVERSATION TEXT -> run id
  req POST "/api/conversations/$1/messages" "$(jq -n --arg t "$2" '{text:$t}')" | jq -r .run.id
}
reply() { # RUN PARTS_JSON  (start, write parts, complete)
  worker POST "/api/worker/runs/$1/start" '{"attempt":1}' >/dev/null
  worker POST "/api/worker/runs/$1/ops" "$(jq -n --argjson parts "$2" '{attempt:1, ops: [$parts | to_entries[] | {op:"part.set", index:.key, part:.value}]}')" >/dev/null
}
complete() { worker POST "/api/worker/runs/$1/complete" '{"attempt":1,"model":"seed"}' >/dev/null; }

# Older conversations first, so "Kasım planı" is the most recent.
BAYI=$(conversation "$MTM" "Bayi duyurusu")
RUN=$(user_message "$BAYI" "Bayilere kasım kampanyası için kısa bir duyuru yaz.")
if [ -n "$TOKEN" ]; then
  reply "$RUN" '[{"type":"text","text":"Değerli bayimiz, kasım boyunca Venta Borinc siparişlerinde ikinci paletten itibaren yüzde 5 indirim uyguluyoruz. Ayrıntılar için bölge sorumlunuzla görüşebilirsiniz."}]'
  complete "$RUN"
fi

# Two grayscale test photos (stdlib-only PNG writer) attached with aliases and @mentions.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
python3 - "$TMP" <<'PY'
import struct, sys, zlib
def png(path, w, h, horizon, sun_x):
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            if y < h * horizon:
                dx, dy = x - sun_x, y - h * horizon * 0.45
                v = 248 if dx * dx + dy * dy < 45 * 45 else 222
            else:
                stripe = ((x - w / 2) * 40 // max(1, y - int(h * horizon) + 20)) % 2
                v = 104 if stripe else 88
            row.append(v)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b""))
png(sys.argv[1] + "/tarla.png", 540, 675, 0.42, 380)
png(sys.argv[1] + "/depo.png", 540, 675, 0.62, 120)
PY
upload() { # FILE -> asset id
  curl -fsS -X POST "$API/api/assets" -F "file=@$1;type=image/png" -F "brandId=$MTM" -F kind=image -F width=540 -F height=675 | jq -r .id
}
TARLA=$(upload "$TMP/tarla.png")
DEPO=$(upload "$TMP/depo.png")
HASAT=$(conversation "$MTM" "Hasat sezonu serisi")
RUN=$(req POST "/api/conversations/$HASAT/messages" "$(jq -n --arg a "$TARLA" --arg b "$DEPO" '{text:"Hasat serisi için dört post hazırla. @image tarladan, @image-1 depodan; ilk postta @image kullan.", attachments:[{assetId:$a},{assetId:$b}]}')" | jq -r .run.id)
if [ -n "$TOKEN" ]; then
  reply "$RUN" '[
    {"type":"text","text":"Tamam. Kapak postunu @image ile, saklama ipucunu @image-1 ile hazırlıyorum."},
    {"type":"progress","stepId":"posts","label":"Postlar hazırlanıyor","state":"done","current":4,"total":4}
  ]'
  complete "$RUN"
fi

conversation "$KOC" "Konser duyurusu" >/dev/null
conversation "$FINVO" "Ekim raporu" >/dev/null
conversation "$BURAK" "Portfolyo güncellemesi" >/dev/null

LANSMAN=$(conversation "$MTM" "Venta Borinc lansmanı")
RUN=$(user_message "$LANSMAN" "Venta Borinc lansmanı için üç post hazırlayalım.")
if [ -n "$TOKEN" ]; then
  reply "$RUN" '[
    {"type":"text","text":"Lansman için üç post öneriyorum: duyuru, ürün detayı ve bayi listesi. Başlamadan önce bir şeyi netleştirelim."},
    {"type":"question","questionId":"launch-date","prompt":"Lansman hangi gün yayına girsin?","mode":"single","allowText":true,
     "options":[{"id":"nov-20","label":"20 Kasım"},{"id":"nov-25","label":"25 Kasım"},{"id":"dec-1","label":"1 Aralık"}]}
  ]'
  complete "$RUN"
fi

KASIM=$(conversation "$MTM" "Kasım planı")
RUN=$(user_message "$KASIM" "MTM için bu ayın postlarını üret, resimleri ben yükleyeceğim.")
if [ -z "$TOKEN" ]; then
  echo "No STUDIO_SEED_WORKER_TOKEN: skipped assistant replies, plan and posts."
  exit 0
fi
reply "$RUN" '[{"type":"text","text":"Kasım için 12 post hazırladım. 6 tanesinde görsel yerini boş bıraktım."}]'
PLAN=$(worker PUT "/api/worker/runs/$RUN/plan" "$(jq -n --argjson items "$ITEMS" '{attempt:1, title:"Kasım planı", periodStart:"2026-11-01", periodEnd:"2026-11-30", summary:"12 postluk Kasım planı hazır. Onaylarsan üretime başlarım.", items:$items}')" | jq -r .plan.id)
complete "$RUN"

# The owner accepted the plan: one draft post per item.
REV=$(req GET "/api/plans/$PLAN" | jq -r .revision)
req POST "/api/plans/$PLAN/accept" "{\"revision\":$REV}" >/dev/null

# Play the generator: one version per post (slots empty where the plan asked for the owner's image).
slide() { # TITLE PILLAR EMPTY_SLOT
  SLOT=""
  if [ "$3" = "1" ]; then
    SLOT='<div data-layer="photo" data-type="slot" data-slot-ratio="1:1" data-slot-state="empty" data-slot-label="Ürün fotoğrafı" style="position:absolute;left:72px;top:400px;width:936px;height:936px"></div>'
  fi
  printf '<!doctype html><html lang="tr"><head><meta charset="utf-8"></head><body data-artboard="1080x1350" style="margin:0;width:1080px;height:1350px"><p data-layer="eyebrow" data-type="text">%s</p><h1 data-layer="title" data-type="text">%s</h1>%s</body></html>' "$2" "$1" "$SLOT"
}
caption_for() {
  case "$1" in
    "Venta Borinc") printf 'Bor ve çinko bir arada. Venta Borinc ile tanışın.\nAyrıntılar için bayinize danışın.\n\n#mtmagro #venta #borinc #bor #çinko #bitkibesleme' ;;
    "Doğru saklama rehberi") printf 'Gübreyi kuru, serin ve güneş almayan bir yerde saklayın.\n\n#mtmagro #saklama' ;;
    "Bayi buluşması") printf 'Bayi buluşmamız 20 Kasım'"'"'da Konya'"'"'da. Yerinizi ayırtın.\n\n#mtmagro #bayi' ;;
    *) printf '%s için açıklama taslağı.\n\n#mtmagro' "$1" ;;
  esac
}
req GET "/api/plans/$PLAN" | jq -c '.items[] | {contentId, title, pillar, imageSlot}' | while read -r ITEM; do
  CID=$(echo "$ITEM" | jq -r .contentId)
  TITLE=$(echo "$ITEM" | jq -r .title)
  PILLAR=$(echo "$ITEM" | jq -r .pillar)
  EMPTY=$( [ "$(echo "$ITEM" | jq -r .imageSlot)" = "user_upload" ] && echo 1 || echo 0 )
  HTML=$(slide "$TITLE" "$PILLAR" "$EMPTY")
  HASH=$(req POST "/api/contents/$CID/versions" "$(jq -n --arg h "$HTML" '{origin:"generated", slides:[{html:$h, width:1080, height:1350}]}')" | jq -r .contentHash)
  req PATCH "/api/contents/$CID" "$(jq -n --arg c "$(caption_for "$TITLE")" '{caption:$c}')" >/dev/null
  case "$TITLE" in
    "Soru cevap"|"Ay sonu"|"Sezon kapanışı")
      req POST "/api/contents/$CID/approve" "{\"hash\":\"$HASH\"}" >/dev/null ;;
  esac
  if [ "$TITLE" = "Sezon kapanışı" ]; then
    req POST /api/schedules "{\"contentId\":\"$CID\",\"socialAccountId\":\"$IG\",\"scheduledAt\":\"2026-11-30T06:00:00.000Z\"}" >/dev/null
  fi
done

# A follow-up turn that is still waiting for the owner's decision.
RUN=$(user_message "$KASIM" "Aralık için de bir taslak çıkar, yine görselleri ben yüklerim.")
reply "$RUN" '[{"type":"text","text":"Aralık için 4 post planladım. 2 tanesinde görsel yerini boş bıraktım."}]'
worker PUT "/api/worker/runs/$RUN/plan" '{"attempt":1,"title":"Aralık planı","periodStart":"2026-12-01","periodEnd":"2026-12-31","summary":"4 postluk Aralık taslağı hazır. Onaylarsan üretime başlarım.","items":[
  {"date":"2026-12-02","platforms":["instagram"],"contentType":"post","title":"Kış bakımı","pillar":"Rehber","imageSlot":"none"},
  {"date":"2026-12-09","platforms":["instagram","facebook"],"contentType":"post","title":"Yılın ürünü","pillar":"Ürün","imageSlot":"user_upload"},
  {"date":"2026-12-16","platforms":["instagram"],"contentType":"post","title":"Bayi ödülleri","pillar":"Kampanya","imageSlot":"user_upload"},
  {"date":"2026-12-30","platforms":["instagram","facebook"],"contentType":"post","title":"Yeni yıl","pillar":"Özet","imageSlot":"none"}
]}' >/dev/null
complete "$RUN"

# The runs above were completed by this script, not by a worker, so their
# chat.turn jobs are still queued. Cancel them so the queue reflects reality.
for JOB in $(req GET "/api/jobs?type=chat.turn&status=queued&limit=100" | jq -r '.items[].id'); do
  req POST "/api/jobs/$JOB/cancel" >/dev/null
done

echo "Done: brands MTM Agro ($MTM), Koç Chords, Finvo, burakkoc.net; 12 posts; 7 conversations."
