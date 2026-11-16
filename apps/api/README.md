# @studio/api

Cloudflare Workers API (Hono + `@hono/zod-openapi`), `Hub` Durable Object, D1 (Drizzle) ve R2.
Şemalar `packages/contract` içindedir; web, worker ve iOS aynı sözleşmeyi kullanır.

## Veri modeli

Tüm kimlikler zamana göre sıralı UUIDv7 metnidir. Zaman damgaları UTC milisaniye olarak tutulur, API'de ISO 8601 (`...Z`) döner.
JSON alanları metin sütunudur. Durum sütunlarında CHECK kısıtı vardır; değerler sözleşmedeki zod enum'larıyla aynıdır (bir test bunu denetler).

| Tablo                    | İçerik                                                                                                                          | Önemli kurallar                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `brands`                 | ad, `slug` (benzersiz), varsayılan dil, durum `active` / `archived`                                                             | Silinmez, arşivlenir. `slug` verilmezse addan türetilir (Türkçe harfler ASCII'ye çevrilir).       |
| `social_accounts`        | marka, platform `instagram` / `facebook` / `linkedin`, görünen ad, dış kimlik, durum                                            | Token ya da gizli bilgi **yok**. Token kasası (Faz 3) ayrı tabloda, hesap kimliğine bağlı olacak. |
| `brand_profiles`         | marka, sürüm no, durum `draft` / `approved`, `tokens` (JSON), tasarım kuralları, ses tonu, onay zamanı, `is_current`            | Taslak düzenlenir, onaylı sürüm değişmez. Marka başına tek "current" (kısmi benzersiz indeks).    |
| `assets`                 | marka, tür, kaynak (`upload` / `generated` / `ingested`), R2 anahtarı, mime, boyut, SHA-256, en/boy/süre, özgün dosya adı       | R2 anahtarı: `brands/{brandId}/assets/{assetId}.{uzantı}`.                                        |
| `contents`               | marka, tür (`post` / `carousel` / `story` / `reel`), başlık, brif, durum, hedef platformlar, açıklama metni, güncel sürüm, onay | Onay = sürüm kimliği + o sürümün hash'i + zaman.                                                  |
| `content_versions`       | içerik, sürüm no, köken (`generated` / `manual_edit` / `ai_edit`), içerik hash'i, slayt sayısı, not, üreten iş                  | Sürüm değişmez; yalnızca not ve render varlıkları sonradan güncellenir (hash'i etkilemez).        |
| `content_version_slides` | sürüm, sıra, HTML belgesi, pano en/boy, render edilmiş varlık                                                                   | Slayt başına bir satır: D1'in 2 MB satır sınırına takılmamak ve render'ı gerçek FK yapmak için.   |
| `jobs`                   | tür, durum, marka, içerik, payload, çıktı (`output`), hata, ilerleme, zamanlar                                                  | Şimdilik yalnızca kayıt. Hub'a dağıtım F1-6'da.                                                   |
| `schedules`              | içerik, marka, platform, sosyal hesap, dondurulmuş sürüm + hash, UTC zaman, durum                                               | İçerik + hesap başına tek etkin (`pending`/`publishing`) zamanlama.                               |
| `publish_logs`           | zamanlama, deneme no, durum, dış gönderi kimliği, hata, zamanlar                                                                | Yazan yayın motoru (Faz 3); bu görevde yalnızca okuma.                                            |

### İçerik durumları (PLAN.md §8)

```
draft ──► in_review ──► approved ──► scheduled ──► publishing ──► published
  ▲  └────────(onay)───────▲  │          │                 └──► failed
  └──── yeni sürüm / geri çekme ◄────────┘
```

- **Onay hash'e bağlıdır.** `POST /api/contents/{id}/approve` gövdesi `{ hash }` taşır; hash güncel sürümün
  `contentHash` değerine eşit olmalıdır, değilse `409 hash_mismatch`. Hash'i sunucu hesaplar
  (`computeContentHash`: slaytların sırayla `{width, height, html}` JSON'unun SHA-256'sı); istemci aynı fonksiyonla doğrulayabilir.
- **Yeni sürüm içeriği taslağa döndürür.** Onay temizlenir, bekleyen zamanlamalar iptal edilir. `publishing` ve `published` içerikte yeni sürüm eklenemez (`409`).
- **Açıklama metni ya da hedef platform değişirse** onay düşer (taslağa döner). Başlık ve brif serbestçe değişir.
- Elle istenebilen geçişler: `draft → in_review`, `in_review → draft`, `approved → draft` (geri çekme), `failed → draft`, `failed → approved`.
  `scheduled` yalnızca zamanlama oluşturunca, `publishing / published / failed` yalnızca yayın motoruyla gelir.
- Tüm kurallar `packages/contract/src/content.ts` içinde (`CONTENT_TRANSITIONS`, `MANUAL_CONTENT_TRANSITIONS`).

## Uçlar

Tam liste ve şemalar: `GET /api/openapi.json`.

| Kaynak          | Uçlar                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markalar        | `GET/POST /api/brands`, `GET/PATCH /api/brands/{id}`                                                                                                                                                                  |
| Marka profili   | `GET/POST /api/brands/{brandId}/profiles`, `GET …/profiles/current`, `GET/PATCH …/profiles/{version}`, `POST …/profiles/{version}/approve`                                                                            |
| Sosyal hesaplar | `GET/POST /api/social-accounts`, `GET/PATCH /api/social-accounts/{id}`                                                                                                                                                |
| Varlıklar       | `GET /api/assets`, `POST /api/assets` (multipart: `file`, `brandId`, isteğe bağlı `kind`, `source`, `width`, `height`, `durationMs`), `GET /api/assets/{id}`, `GET /api/assets/{id}/content` (Range ve ETag destekli) |
| İçerikler       | `GET/POST /api/contents`, `GET/PATCH/DELETE /api/contents/{id}`, `POST …/approve`, `POST …/transition`                                                                                                                |
| Sürümler        | `GET/POST /api/contents/{id}/versions`, `GET/PATCH /api/contents/{id}/versions/{version}`                                                                                                                             |
| İşler           | `GET/POST /api/jobs`, `GET /api/jobs/{id}`                                                                                                                                                                            |
| Zamanlama       | `GET/POST /api/schedules`, `GET /api/schedules/{id}`, `POST …/cancel`, `GET …/logs`                                                                                                                                   |

Mevcut `/api/health`, `/api/openapi.json`, `/api/hub` ve yalnızca geliştirmede açık `/api/dev/*` uçları aynen duruyor.

**Hata biçimi** (tüm 2xx dışı yanıtlar): `{ "error": { "code", "message", "issues"? } }`.
Kodlar: `validation_error` 400, `not_found` 404, `conflict` / `invalid_transition` / `hash_mismatch` 409, `payload_too_large` 413, `unsupported_media_type` 415, `internal_error` 500.

**Sayfalama:** liste uçları `limit` (1–100, varsayılan 20) ve `cursor` alır; yanıt `{ items, nextCursor }`. `nextCursor` opaktır, son sayfada `null`.
Listeler en yeniden eskiye sıralıdır; zamanlamalar `scheduledAt`'e göre artan sıradadır.

**Yükleme sınırları:** izinli mime listesi ve tür başına boyut sınırı `ASSET_MIME_RULES` içinde (görsel 20 MiB, SVG 2 MiB, font 5 MiB, video ve ses 50 MiB, PDF 20 MiB).
Dosya içeriği bildirilen türle eşleşmezse (ör. PNG adı altında metin) `415`. Dosyalar `nosniff` ve `sandbox` CSP ile sunulur (SVG içindeki betik çalışmaz).

**Kimlik doğrulama:** `src/middleware/access.ts` içindeki `cloudflareAccess` tek giriş noktasıdır; şimdilik hiçbir şey yapmaz. Cloudflare Access kurulunca JWT doğrulaması buraya eklenecek.

## Migration

Şema `src/db/schema.ts`. Migration SQL'leri `migrations/` altında (`0000_init`, `0001_core_model`).

```sh
pnpm --filter @studio/api db:generate --name <kisa_ad>      # şema değişince yeni migration üretir (çevrimdışı)
pnpm --filter @studio/api db:migrate                       # yerel D1'e uygular (.wrangler/state)
```

Uzak D1'e migration uygulanmadı; dağıtım görevi bunu yapacak.

## Test

```sh
pnpm --filter @studio/api test
```

Testler `@cloudflare/vitest-plugin` ile workerd içinde koşar. `test/apply-migrations.ts` her çalıştırmada tüm migration'ları
test D1'ine uygular; R2 ve Durable Object da yerelde taklit edilir. Dosyalar: `api.test.ts` (sağlık, OpenAPI, şema, hub),
`brands`, `brand-profiles`, `assets`, `contents` (onay hash kuralı dahil), `jobs-schedules`.

Elle deneme (API çalışırken, `pnpm dev`):

```sh
B=$(curl -s -X POST localhost:8787/api/brands -H 'content-type: application/json' -d '{"name":"Deneme"}' | jq -r .id)
C=$(curl -s -X POST localhost:8787/api/contents -H 'content-type: application/json' \
  -d "{\"brandId\":\"$B\",\"type\":\"post\",\"title\":\"İlk post\",\"targetPlatforms\":[\"instagram\"]}" | jq -r .id)
H=$(curl -s -X POST localhost:8787/api/contents/$C/versions -H 'content-type: application/json' \
  -d '{"origin":"generated","slides":[{"html":"<html></html>","width":1080,"height":1350}]}' | jq -r .contentHash)
curl -s -X POST localhost:8787/api/contents/$C/approve -H 'content-type: application/json' -d "{\"hash\":\"$H\"}"
```
