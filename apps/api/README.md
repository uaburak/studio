# @studio/api

Cloudflare Workers API (Hono + `@hono/zod-openapi`), `Hub` Durable Object, D1 (Drizzle) ve R2.
Şemalar `packages/contract` içindedir; web, worker ve iOS aynı sözleşmeyi kullanır.

## Veri modeli

Tüm kimlikler zamana göre sıralı UUIDv7 metnidir. Zaman damgaları UTC milisaniye olarak tutulur, API'de ISO 8601 (`...Z`) döner.
JSON alanları metin sütunudur. Durum sütunlarında CHECK kısıtı vardır; değerler sözleşmedeki zod enum'larıyla aynıdır (bir test bunu denetler).

| Tablo                      | İçerik                                                                                                                                                               | Önemli kurallar                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `brands`                   | ad, `slug` (benzersiz), varsayılan dil, durum `active` / `archived`                                                                                                  | Silinmez, arşivlenir. `slug` verilmezse addan türetilir (Türkçe harfler ASCII'ye çevrilir).           |
| `social_accounts`          | marka, platform `instagram` / `facebook` / `linkedin`, görünen ad, dış kimlik, durum                                                                                 | Token ya da gizli bilgi **yok**. Token kasası (Faz 3) ayrı tabloda, hesap kimliğine bağlı olacak.     |
| `brand_profiles`           | marka, sürüm no, durum `draft` / `approved`, `tokens` (JSON), tasarım kuralları, ses tonu, onay zamanı, `is_current`                                                 | Taslak düzenlenir, onaylı sürüm değişmez. Marka başına tek "current" (kısmi benzersiz indeks).        |
| `assets`                   | marka, tür, kaynak (`upload` / `generated` / `ingested`), R2 anahtarı, mime, boyut, SHA-256, en/boy/süre, özgün dosya adı                                            | R2 anahtarı: `brands/{brandId}/assets/{assetId}.{uzantı}`.                                            |
| `contents`                 | marka, tür (`post` / `carousel` / `story` / `reel`), başlık, brif, durum, hedef platformlar, açıklama metni, güncel sürüm, onay                                      | Onay = sürüm kimliği + o sürümün hash'i + zaman.                                                      |
| `content_versions`         | içerik, sürüm no, köken (`generated` / `manual_edit` / `ai_edit`), içerik hash'i, slayt sayısı, not, üreten iş                                                       | Sürüm değişmez; yalnızca not ve render varlıkları sonradan güncellenir (hash'i etkilemez).            |
| `content_version_slides`   | sürüm, sıra, HTML belgesi, pano en/boy, render edilmiş varlık                                                                                                        | Slayt başına bir satır: D1'in 2 MB satır sınırına takılmamak ve render'ı gerçek FK yapmak için.       |
| `jobs`                     | tür, durum, marka, içerik, payload, çıktı (`output`), hata, ilerleme (+ mesaj), öncelik, deneme / en fazla deneme, worker, kiralama, zamanlar                        | İşlerin tek doğru kaynağı. Oluşturma API'de, sonraki her geçiş Hub'da (aşağıda "İş kuyruğu").         |
| `schedules`                | içerik, marka, platform, sosyal hesap, dondurulmuş sürüm + hash, UTC zaman, durum                                                                                    | İçerik + hesap başına tek etkin (`pending`/`publishing`) zamanlama.                                   |
| `publish_logs`             | zamanlama, deneme no, durum, dış gönderi kimliği, hata, zamanlar                                                                                                     | Yazan yayın motoru (Faz 3); bu görevde yalnızca okuma.                                                |
| `conversations`            | marka (isteğe bağlı), başlık, durum `active` / `archived`, `last_seq`, son etkinlik zamanı                                                                           | Silinmez, arşivlenir. Marka bir kez atanır, sonra değişmez.                                           |
| `messages`                 | konuşma, rol `user` / `assistant` / `system`, durum `streaming` / `complete` / `failed` / `cancelled`, üreten tur, `parts` (JSON), `delta_seqs`, `client_message_id` | Tur başına tek asistan mesajı (kısmi benzersiz indeks). `client_message_id` konuşma içinde benzersiz. |
| `agent_runs`               | konuşma, tetikleyen mesaj, `chat.turn` işi, durum, deneme, model, kullanım (JSON), hata, zamanlar                                                                    | Konuşma başına en fazla bir `queued`/`running` tur (kısmi benzersiz indeks).                          |
| `conversation_events`      | konuşma, `seq`, tür, akış çerçevesi (JSON)                                                                                                                           | Canlı akışın kalıcı günlüğü; birincil anahtar `(conversation_id, seq)`.                               |
| `conversation_aliases`     | konuşma, varlık, güncel takma ad (`alias`), takma adı getiren mesaj                                                                                                  | Konuşmada ad ve varlık ayrı ayrı benzersiz. Kimlik (`id`) yeniden adlandırmada değişmez.              |
| `conversation_alias_names` | konuşma, ad, takma ad kimliği                                                                                                                                        | Konuşmada kullanılmış **her** ad (eski adlar dahil); birincil anahtar `(conversation_id, name)`.      |
| `content_plans`            | marka, konuşma, öneren tur, başlık, dönem başı/sonu (`YYYY-MM-DD`), durum, özet, `revision`, karar zamanı, ret nedeni                                                | Durumlar `draft` → `proposed` → `accepted` / `rejected` / `superseded`.                               |
| `plan_items`               | plan, sıra, tarih, platformlar, içerik türü, başlık, brif, sütun (pillar), görsel yuvası `none` / `user_upload` / `ai_generate`, durum, içerik, üretim işi           | Üretim durumu `jobs` tablosundan canlı okunur; `generation_status` yalnızca değişiklik tespiti için.  |

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

### Katman kutuları (`Slide.layers`, P1)

Her slayt, render edildiği andaki `[data-layer]` kutularını taşır (`SlideLayerBox`: kimlik, tür, rol, üst grup,
artboard pikselinde `x/y/w/h`, görünürlük). Worker render ettikçe `PATCH …/versions/{version}` ile `layouts` olarak
yazar (`content_version_slides.layers`, migration `0009_slide_layouts`); hash'i etkilemez. Editörler seçim kutularını
buradan çizer; ölçülmemiş slaytta `null`.

## Uçlar

Tam liste ve şemalar: `GET /api/openapi.json`.

| Kaynak          | Uçlar                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markalar        | `GET/POST /api/brands`, `GET/PATCH /api/brands/{id}`                                                                                                                                                                    |
| Marka profili   | `GET/POST /api/brands/{brandId}/profiles`, `GET …/profiles/current`, `GET/PATCH …/profiles/{version}`, `POST …/profiles/{version}/approve`                                                                              |
| Marka kiti      | `GET/PUT /api/brands/{brandId}/kit` (aşağıda)                                                                                                                                                                           |
| Sosyal hesaplar | `GET/POST /api/social-accounts`, `GET/PATCH /api/social-accounts/{id}`                                                                                                                                                  |
| Varlıklar       | `GET /api/assets`, `POST /api/assets` (multipart: `file`, `brandId`, isteğe bağlı `kind`, `source`, `width`, `height`, `durationMs`), `GET /api/assets/{id}`, `GET /api/assets/{id}/content` (Range ve ETag destekli)   |
| İçerikler       | `GET/POST /api/contents`, `GET/PATCH/DELETE /api/contents/{id}`, `POST …/approve`, `POST …/transition`, `POST …/duplicate` (güncel sürümle yeni taslak kopya)                                                           |
| Sürümler        | `GET/POST /api/contents/{id}/versions`, `GET/PATCH /api/contents/{id}/versions/{version}`, `POST …/versions/{version}/restore` (eski sürümün birebir kopyası yeni sürüm olur; render ve katman kutuları korunur)        |
| İşler           | `GET/POST /api/jobs`, `GET /api/jobs/{id}`, `POST /api/jobs/{id}/cancel`, `GET /api/jobs/stream` (WebSocket, canlı izleme)                                                                                              |
| Worker          | `GET /api/workers/presence` (Mac çevrimiçi mi, şu an çalışan işler, kuyruk uzunluğu); `GET /api/hub` (worker WebSocket'i, token ister)                                                                                  |
| Zamanlama       | `GET/POST /api/schedules`, `GET /api/schedules/{id}`, `POST …/cancel`, `GET …/logs`                                                                                                                                     |
| Konuşmalar      | `GET/POST /api/conversations`, `GET/PATCH /api/conversations/{id}`, `GET/POST …/messages`, `POST …/messages/{messageId}/answer`, `GET …/runs`, `GET …/stream` (WebSocket), `GET …/aliases`, `PATCH …/aliases/{aliasId}` |
| Ajan turları    | `GET /api/agent-runs/{id}`, `POST /api/agent-runs/{id}/cancel`                                                                                                                                                          |
| Planlar         | `GET /api/plans`, `GET/PATCH /api/plans/{id}`, `POST …/accept`, `POST …/reject`, `POST …/generate`                                                                                                                      |
| Worker turu     | `POST /api/worker/runs/{runId}/start`, `GET …/context`, `POST …/ops`, `PUT …/plan`, `POST …/complete`, `POST …/fail` (worker token'ı ister)                                                                             |

**Marka kiti** (P2): logolar (zemin `any`/`light`/`dark`), fontlar (aile, rol, lisans notu), palet (`#RRGGBB`),
örnek postlar (3–12) ve notlar. Tek JSON belge olarak MEDIA'da `brands/{id}/kit.json` tutulur (migration yok);
her dosya aynı markanın uygun türde varlığı olmalı, değilse `400`. `brand.analyze` bunu okur.

`/api/health` ve `/api/openapi.json` aynen duruyor. Yalnızca geliştirmede açık `/api/dev/*` uçları artık gerçek iş yolunun
ince takma adları: `POST /api/dev/jobs/demo` bir `demo.echo` işini `POST /api/jobs` ile aynı şekilde D1'e yazar,
`GET /api/dev/jobs/{id}` D1'den okur, `GET /api/dev/hub` bağlı worker sayısını verir. Hub'ın ayrı iş deposu kaldırıldı.

**Hata biçimi** (tüm 2xx dışı yanıtlar): `{ "error": { "code", "message", "issues"? } }`.
Kodlar: `validation_error` 400, `not_found` 404, `conflict` / `invalid_transition` / `hash_mismatch` 409, `payload_too_large` 413, `unsupported_media_type` 415, `internal_error` 500.

**Sayfalama:** liste uçları `limit` (1–100, varsayılan 20) ve `cursor` alır; yanıt `{ items, nextCursor }`. `nextCursor` opaktır, son sayfada `null`.
Listeler en yeniden eskiye sıralıdır; zamanlamalar `scheduledAt`'e göre artan sıradadır.

**Yükleme sınırları:** izinli mime listesi ve tür başına boyut sınırı `ASSET_MIME_RULES` içinde (görsel 20 MiB, SVG 2 MiB, font 5 MiB, video ve ses 50 MiB, PDF 20 MiB).
Dosya içeriği bildirilen türle eşleşmezse (ör. PNG adı altında metin) `415`. Dosyalar `nosniff` ve `sandbox` CSP ile sunulur (SVG içindeki betik çalışmaz).

**Kimlik doğrulama:** `src/middleware/access.ts` içindeki `accessControl` tek giriş noktasıdır (aşağıda "Mac'te çalışma, erişim ve cihaz eşleştirme").

## Mac'te çalışma, erişim ve cihaz eşleştirme (L1)

API sahibin Mac'inde çalışır: Mac uygulaması `wrangler dev`'i `127.0.0.1:8790`'da, durumu
`~/Library/Application Support/Studio/api/state` altında (`--persist-to`) başlatır, önce migration'ları uygular
(ayrıntı: `apps/apple/README.md`). Telefonlar aynı ağdan **yerel ağ geçidi** ile gelir: `scripts/lan-gateway.mjs`
(`0.0.0.0:8791` → `127.0.0.1:8790`, HTTP ve WebSocket, bağımlılıksız Node).

**Neden geçit:** Miniflare `CF-Connecting-IP`'yi soketten yalnızca istemci göndermediyse yazar; ağdaki biri
`CF-Connecting-IP: 127.0.0.1` gönderip "yerel" görünebilirdi (denendi). Bu yüzden workerd yalnızca `127.0.0.1`'i dinler;
geçit başlığı gerçek karşı adresle **ezer** ve `X-Studio-Gateway: 1` ekler. Bu işareti taşıyan istek, karşı adresi
`127.0.0.1` olsa bile (ör. ileride aynı Mac'teki tünel bağlayıcısı) asla yerel sayılmaz. L3'te tünel geçide bağlanmalı,
doğrudan workerd'ye değil.

**Kim girebilir** (`/api/*`, `accessControl`):

| İstek                                                                | Sonuç                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /api/health`, `POST /api/pairing/claim`                         | herkese açık (claim hız sınırlı)                           |
| Bu Mac'ten doğrudan (`CF-Connecting-IP` loopback, geçit işareti yok) | `local`: her şey                                           |
| `Authorization: Bearer <WORKER_TOKEN>`                               | `worker` (`/api/hub` ve `/api/worker/*` ayrıca bunu ister) |
| `Authorization: Bearer <cihaz anahtarı>` (eşleşmiş, iptal edilmemiş) | `device`; `last_seen_at` en fazla dakikada bir yazılır     |
| diğer her şey (adres bilinmiyorsa da)                                | `401 unauthorized`, `WWW-Authenticate: Bearer`             |

Cihaz yönetimi (`POST /api/pairing/codes`, `GET /api/devices`, `POST /api/devices/{id}/revoke`) yalnızca `local`;
cihaz ya da worker anahtarıyla `403 forbidden`. Yeni hata kodları: `unauthorized` 401, `forbidden` 403, `rate_limited` 429.

**Eşleştirme** (şemalar: `packages/contract/src/device.ts`):

1. Mac uygulaması `POST /api/pairing/codes` → `{ code, expiresAt }`: 6 hane, 2 dakika, tek kullanımlık; yeni kod
   kullanılmamış eskileri geçersiz kılar (aynı anda tek geçerli kod).
2. Telefon `POST /api/pairing/claim { code, deviceName, platform }` → `201 { device, token }`. Anahtar `sdt_` + 32
   rastgele baytın base64url'i; sunucu yalnızca SHA-256'sını tutar, anahtar bir kez gösterilir. Kod koşullu bir
   `UPDATE … WHERE used_at IS NULL AND expires_at > now` ile harcanır (yarışta ikinci istek kaybeder).
   Yanlış, süresi dolmuş ya da kullanılmış kod aynı yanıtı alır: `401 unauthorized`.
3. Hız sınırı: son 10 dakikada aynı adresten 5, tüm adreslerden toplam 20 başarısız deneme olunca her claim (doğru kod
   dahil) `429 rate_limited` + `Retry-After` alır. 1 000 000 olasılığa karşı 10 dakikada en fazla 20 tahmin.
4. `POST /api/devices/{id}/revoke` anahtarı anında geçersiz kılar (kayıt `revokedAt` ile listede kalır).

Tablolar (`0006_devices`): `devices` (ad, platform, `token_hash` benzersiz, son görülme, iptal), `pairing_codes`
(kod hash'i, bitiş, kullanım, cihaz), `pairing_failures` (adres, zaman; pencere dışındakiler her claim'de silinir).

`GET /api/health` isteğe bağlı `instance` alanı taşır (`STUDIO_INSTANCE_ID`, Mac uygulaması verir): uygulama kendi çalışan
kopyasını elle başlatılmış bir API'den ayırıp ona bağlanır. `wrangler.jsonc` `vars` içinde boş varsayılanla tanımlı;
ortam değişkeni onu ezer. Elle `pnpm dev` ile çalışırken her şey eskisi gibidir (istekler 127.0.0.1'den gelir).

## İş kuyruğu ve Hub (F1-6)

D1 `jobs` tablosu tek doğru kaynaktır; `Hub` Durable Object (tek örnek, `main`) dağıtıcıdır. Hub bellekte iş durumu
tutmaz: her karar D1'den okunur, her geçiş koşullu bir `UPDATE … WHERE status = <beklenen> RETURNING` ile yazılır
(`src/hub/store.ts`). Böylece tekrarlanan mesaj, yeniden çalışan alarm ya da yeniden başlayan Hub bir geçişi iki kez
uygulayamaz. Mesajlar, RPC'ler ve alarm Hub içinde sıraya alınır (D1 çağrıları DO'nun giriş kapısını açtığı için).

```
            POST /api/jobs                       Hub: dispatch (öncelik ↓, sonra FIFO; worker kapasitesi kadar)
  (yok) ──────────────► queued ─────────────────────────────────► running (atandı, ack bekleniyor, 20 sn)
                          ▲  │ cancel                                │ job.ack / progress / heartbeat → kiralama 60 sn
                          │  ▼                                       ▼
                          │ cancelled                             running (kiralamalı)
                          │                                          │
     kiralama doldu /     ├──── ack gelmedi: deneme iade ◄───────────┤
     worker yeniden       ├──── job.release (düzgün kapanış): iade ◄─┤
     başladı              └──── deneme < en fazla: yeniden kuyruk ◄──┤
                                                                     ├─► failed  (deneme hakkı bitti: "worker … lost the job …")
                                     job.result ─────────────────────┼─► succeeded / failed / cancelled
                                     cancel isteği → job.cancel ─────┘   (worker 30 sn'de onaylamazsa cancelled)
```

- **Oluşturma:** `POST /api/jobs` işi `queued` olarak yazar, sonra Hub'a `jobCreated` RPC'si ile haber verir. Haber
  ulaşmazsa iş yine kaybolmaz: Hub, bağlı bir worker varken en geç 60 sn'de bir kuyruğa bakar ve her `hello`'da dağıtır.
  İsteğe bağlı `priority` (-100..100, varsayılan 0) ve `maxAttempts` (1..10, varsayılan 3).
- **Dağıtım:** yalnızca worker'ın `hello`'da bildirdiği türler (`capabilities`) ve `concurrency` kadar iş gönderilir.
  Worker'ın yapamadığı türler kuyrukta bekler (presence'taki `queueLength` bunu gösterir).
- **Ack ve kiralama:** dağıtılan iş 20 sn içinde `job.ack` ile onaylanmalıdır; onaylanmazsa deneme sayılmadan kuyruğa döner.
  Onaydan sonra `job.progress` ve `job.heartbeat` kiralamayı 60 sn uzatır. Kiralama dolunca DO alarmı işi kuyruğa
  geri koyar; `attempts >= maxAttempts` ise iş açık bir hata ile `failed` olur. Süreler `src/hub/config.ts`.
- **Yeniden bağlanma:** worker `hello.activeJobIds` ile elindeki işleri bildirir. Hub bu worker'a atanmış ama listede
  olmayan işleri hemen kuyruğa koyar (worker yeniden başlamış), listede olup kuyruğa dönmüş olanları geri verir.
  Aynı `workerId` ile yeni bağlantı eskisini kapatır (4002).
- **Sonuç tam bir kez:** ilk `job.result` koşullu güncelleme ile kabul edilir; her sonuç (tekrarlar ve bilinmeyen işler
  dahil) `job.result.ack` ile onaylanır, worker de o zaman outbox'ından siler. Önce D1, sonra ack: arada bir çöküş
  yalnızca yeniden gönderime yol açar. İşi artık tutmayan bir worker'ın geç gelen _başarılı_ sonucu kabul edilir;
  başarısız/iptal sonucu ise başka bir worker'ın denemesini bitiremez. `retryable: true` başarısızlık, deneme hakkı varsa
  kuyruğa döner.
- **İptal:** `queued` iş hemen `cancelled`; `running` iş `cancelRequestedAt` alır, worker'a `job.cancel` gider, worker
  handler'ı durdurup `cancelled` sonucu gönderir. 30 sn içinde onay gelmezse (worker kopmuşsa) alarm işi `cancelled` yapar.
  Bitmiş işte `409 invalid_transition`. İptal istendikten sonra handler yine de başarıyla biterse sonuç `succeeded` kalır.
- **Hub yeniden başlarsa:** D1 ve DO alarmı kalıcıdır; soketler kopar, worker yeniden bağlanıp `hello` gönderir ve
  yukarıdaki uzlaştırma çalışır. Uyuyan (hibernation) soketler ek bir şey gerektirmez. DO deposunda yalnızca worker'ın
  son görülme zamanı (`presence:lastSeenAt`) tutulur.
- **Yetkilendirme:** worker `/api/hub`'a `Authorization: Bearer <WORKER_TOKEN>` gönderir; sabit zamanlı karşılaştırılır
  (`src/hub/auth.ts`). `WORKER_TOKEN` tanımlı değilse hiçbir worker bağlanamaz (503). Yerelde `.dev.vars.example` →
  `.dev.vars`; dağıtımda `wrangler secret put WORKER_TOKEN`. Cloudflare Access kurulunca worker ayrıca Access servis
  token'ı gönderecek ve `middleware/access.ts` JWT'yi doğrulayacak; bu paylaşılan anahtar o zaman ek savunma olarak kalabilir
  ya da kaldırılabilir (tek yer: `hub/auth.ts`).

**Kalıcılık özeti:** D1 `jobs`: durum, payload, çıktı, hata, ilerleme ve mesajı, öncelik, deneme / en fazla deneme,
worker kimliği, kiralama bitişi, dağıtım / ack / iptal isteği / başlangıç / bitiş zamanları. DO alarmı: bir sonraki
kiralama bitişi (ya da 60 sn'lik güvenlik taraması). DO deposu: worker'ın son görülme zamanı. Worker diski: ack
bekleyen sonuçlar (`~/.studio/worker/outbox.json`).

### Canlı izleme: `GET /api/jobs/stream`

WebSocket (Hub üzerinden). `?jobId=` tek iş, `?brandId=` bir markanın işleri, ikisi de yoksa tüm işler. Bağlanınca
`jobs.snapshot` (en yeni 50 iş + presence), sonra her değişiklikte `job.updated` ve worker gelip gidince / kuyruk
değişince `presence` gelir. İstemci `ping` gönderebilir; başka bir şey yok sayılır (istemci soketleri worker gibi
davranamaz). Kopunca yeniden bağlanıp yeni snapshot'ı esas almak yeterli. Tipli istemci: `api.jobs.watch(filtre, { onMessage })`
(yeniden bağlanmayı kendisi yapar), `api.jobs.streamUrl()`, `api.jobs.cancel(id)`, `api.workers.presence()`.

**Neden SSE değil WebSocket:** Hub zaten her durum değişikliğini gören tek yer; istemci soketleri DO hibernation ile
boştayken maliyetsiz bekler. SSE'de ise Worker ya da DO akış boyunca uyanık kalmak zorunda olurdu. iOS'ta
`URLSessionWebSocketTask` yerleşik, SSE için ayrıştırıcı gerekirdi. Access çerezi / servis token'ı WebSocket yükseltme
isteğinde de geçerli.

## Sohbet altyapısı (A2)

Ana yüzey olan AI sohbetinin arka ucu: konuşmalar, mesajlar, ajan turları, içerik planları, worker'ın tur
protokolü ve canlı akış. LLM çağrısı ve arayüz yok; worker tarafı (`chat.turn` ve `content.generate`
handler'ları) A4'te yazılacak. Şemalar: `packages/contract/src/chat.ts`, `plan.ts`, `chat-stream.ts`.

### Akış

```
kullanıcı  POST /api/conversations/{id}/messages {text, attachmentAssetIds, clientMessageId}
             └─► mesaj (user) + agent_run (queued) + iş (chat.turn, öncelik 10, en fazla 2 deneme)   [tek D1 batch]
Hub        job.dispatch ─► Mac worker ─► job.ack
worker     POST /api/worker/runs/{runId}/start {attempt}        ─► tur bağlamı (run → running)
           POST …/ops {ops: [text.delta | part.set, …]}        ─► asistan mesajı akarak yazılır
           PUT  …/plan {dönem, özet, kalemler}                 ─► plan (proposed) + mesajda plan kartı
           POST …/complete {model, usage}  |  POST …/fail {error}
           job.result (hub protokolü)
kullanıcı  POST /api/plans/{id}/accept {revision, skipItemIds}  ─► kalem başına taslak içerik
           POST /api/plans/{id}/generate {itemIds?}             ─► kalem başına content.generate işi
```

### Mesaj parçaları

Her mesaj sıralı, tipli parçalardan oluşur (`MessagePart`): `text`, `attachment` (varlık + sunucunun
kopyaladığı tür/mime/boyut/dosya adı), `plan_proposal` (plan kimliği), `content_ref` (içerik + isteğe bağlı
sürüm), `question` (soru, `single` / `multiple` / `text` modu, seçenekler, serbest metin izni, cevap),
`progress` (adım kimliği, etiket, durum `pending` / `running` / `done` / `failed` / `skipped`, sayaç),
`error`. Kullanıcı soruyu `POST …/messages/{messageId}/answer {questionId, optionIds, text}` ile cevaplar;
cevap kesindir (aynısı tekrar gelirse etkisiz, farklısı `409`). Etkin tur yoksa cevap yeni bir tur başlatır;
soran tur hâlâ etkinse cevabı `GET …/context` ile kendisi okur.

### Kurallar

- **Konuşma başına tek etkin tur.** Tur `queued` ya da `running` iken gelen yeni mesaj `409 conflict` alır
  (kuyruğa alınmaz). Neden: sıradaki bir mesaj, kullanıcının o an görmediği bir tur sonucunun üzerine
  cevaplanırdı; istemci gönder düğmesini tur bitene kadar kapatır ya da önce iptal eder. Veritabanında da
  kısmi benzersiz indeksle güvence altında.
- **`clientMessageId`** ile aynı mesaj tekrar gönderilirse ilk mesaj ve tur `200 { replayed: true }` ile döner
  (mobil ağda yeniden deneme güvenli).
- **Ekler** aynı markanın var olan varlıkları olmalı; markasız konuşmada ek reddedilir (`400`), olmayan varlık `404`.
- **Arşivli konuşma** yeni mesaj ve cevap kabul etmez (`409`). Marka `PATCH` ile yalnızca boşken atanır.
- **Sınırlar:** kullanıcı metni 20 000 bayt, mesaj başına 10 ek, delta 16 KiB, metin parçası 100 KB,
  mesaj 512 KB (aşınca `413 payload_too_large`), mesaj başına 64 parça, çağrı başına 100 işlem, plan başına
  60 kalem, plan dönemi en fazla 92 gün.
- **Durum geçişleri** sunucuda denetlenir (`RUN_TRANSITIONS`, `PLAN_TRANSITIONS`). Plan düzenleme ve kabul
  kullanıcının gördüğü `revision` ile yapılır; uyuşmazsa `409 conflict`.
- `POST /api/jobs` `chat.turn` türünü reddeder (`400`); bu işi yalnızca API kendisi oluşturur.

### Worker tur protokolü (`/api/worker/runs/{runId}/…`)

Kimlik: `/api/hub` ile aynı `Authorization: Bearer <WORKER_TOKEN>`, aynı sabit zamanlı karşılaştırma
(`middleware/worker-auth.ts` → `hub/auth.ts`). Hatalı/eksik token `401` (düz metin, `WWW-Authenticate: Bearer`),
token tanımsızsa `503`. Tipli istemci: `createApiClient({ workerToken })` → `api.workerTurns.*`.

1. `start {attempt}`: `attempt` `job.dispatch`'teki deneme numarası. `queued → running`. Aynı denemeyle tekrar
   çağrılırsa yalnızca bağlamı döner. Daha yüksek deneme (iş yeniden kuyruğa girmişse) önceki denemenin asistan
   mesajını temizler. Bağlam (`TurnContext`): tur, konuşma, marka, güncel onaylı marka profili, son 100 mesaj
   (eskiden yeniye), eklerin varlık bilgileri, açık plan (reddedilmemiş/geçersizleşmemiş en yeni plan),
   şimdiye kadarki asistan mesajı.
2. `ops {attempt?, ops}`: sırayla, hep ya da hiç uygulanır. İlk yazma asistan mesajını (`streaming`) oluşturur.
   - `text.delta {index, seq, text}`: `index`'teki metin parçasına ekler; yeni parça `seq: 1` ile başlar.
     Uygulanmış `seq` atlanır (yeniden deneme güvenli), boşluk `409`.
   - `part.set {index, part}`: sıradaki indekse ekler ya da aynı türdeki parçayı değiştirir (aynısıysa etkisiz).
     Cevaplanmış soru değiştirilemez; tür değişimi ve indeks boşluğu `409`.
3. `PUT plan`: turun planını oluşturur (konuşmadaki diğer açık planlar `superseded`) ya da plan hâlâ
   `draft`/`proposed` ise yerinde değiştirir (`revision + 1`). Aynı gövde etkisizdir. Mesaja plan kartı bir kez
   eklenir. Konuşmanın markası yoksa `brandId` ile atanır.
4. `complete {model, usage}` / `fail {error}`: turu bitirir; mesaj `complete` / `failed` olur, `fail` hatayı
   mesaja `error` parçası olarak ekler. Bitmiş tur için tekrar çağrı etkisizdir.

Tur iptal edilmiş ya da bitmişse her yazma `409 invalid_transition`; `start` öncesi ve eski denemeden gelen
yazma `409 conflict`. Worker sonra her zamanki gibi `job.result` gönderir. Worker turu kapatmadan iş biterse
(çökme, kiralama dolması, `/api/jobs/{id}/cancel`) Hub turu da aynı sonuçla kapatır; iş yeniden kuyruğa
girerse tur `queued`'a döner.

### Neden tüm yazmalar Hub'dan geçiyor

Konuşma ve plan üzerindeki her değişiklik (istemciden, worker'dan ya da iş durumu kancalarından) `Hub.chat()`
RPC'si ile Hub'ın seri kuyruğunda `src/chat/service.ts` içinde çalışır. Böylece kilit gerekmeden:
"etkin tur var mı → yaz", "tur hâlâ yazılabilir mi → yaz", plan revizyonu gibi denetle-yaz adımları
çakışmaz; akış sıra numaraları boşluksuz ve sıralı verilir; değişiklik ve onun akış olayları aynı D1 batch'inde
(tek işlem) yazılır. Okumalar (listeler, bağlam) doğrudan API'den yapılır. Tek kullanıcılı bir uygulama için
Hub'ın seri kuyruğu darboğaz değildir; worker deltaları yine de ~250 ms'de bir toplu göndermelidir.

### Canlı akış: `GET /api/conversations/{id}/stream[?after=<seq>]`

İş akışına tür eklemek yerine **Hub üzerinden kardeş bir akış** seçildi: iş akışı iş/marka filtreli ve
"snapshot'ı esas al" mantığında; sohbet ise konuşma başına sıralı, kaldığı yerden devam edilebilir bir günlük
istiyor. Aynı Hub, aynı hibernation'lı WebSocket'ler (etiket `conv:{id}`), aynı `presence` çerçeveleri.

- Her değişiklik `conversation_events` tablosuna konuşma başına `seq` (1, 2, 3…) ile yazılır.
  Olaylar: `message.created`, `message.updated` (tüm mesaj), `part.added`, `part.updated`, `text.delta`,
  `run.updated`, `plan.updated` (tüm plan, kalemler ve üretim durumuyla), `conversation.updated`.
- `after` yoksa (ya da 1000 olaydan fazla geride / bilinmiyorsa) önce `conversation.snapshot` (o `seq`'e kadarki
  durum: konuşma, son 50 mesaj, etkin tur, planlar, presence). `after` varsa ondan sonraki kayıtlı olaylar sırayla
  ve ardından `conversation.resumed`. Sonra canlı olaylar. `presence` ve `pong` `seq` taşımaz.
- Hub her sokete gönderdiği son `seq`'i sokete bağlı (hibernation'da korunan) ekte tutar ve yeni olayları
  D1'den `seq` sırasıyla okuyup gönderir; böylece sıra ve tamlık uyandırma/yeniden başlamadan etkilenmez.
  Hub yeniden başlarsa soketler kopar, istemci `?after=` ile bağlanır, kaçırdığı olaylar D1'den gelir.
- Referans indirgeyici: `applyConversationStreamMessage(state, frame)` (yinelenenleri atlar, boşlukta
  `stale` işaretler); Swift istemcisi aynen taşıyabilir. Tipli istemci: `api.conversations.watch(id, …)`
  kopunca son `seq` ile kendisi devam eder.

### Planlar ve üretim

Kabul (`accept`) her atlanmamış kalem için taslak içerik oluşturur (tür, başlık, brif, platformlar kalemden;
üretim yok) ve kalemi `accepted` + `contentId` yapar. `generate` kabul edilmiş kalemler için
`content.generate` işleri açar; payload şeması `ContentGeneratePayload` (marka, içerik, başlık, brif, tür,
platformlar, `baseVersion`, görsel yuvası beklentisi ve tarifi, plan kalemi, konuşma, marka profili sürümü,
ek talimat). `POST /api/jobs` bu şemayı geriye uyumluluk için henüz zorlamıyor; worker
`parseContentGenerateJob(job)` ile okur (marka/içerik kimliklerini iş satırından tamamlar). İş durumları plan
kartına `plan.updated` olarak yansır.

### Araçlı ajan (A5): araç adımları, izin kartları, oturum, Claude girişi

- **Yeni parça türleri** (ek, eski istemciler `unknown` olarak atlar): `tool_step {id, name, label, state
  running|done|error, summary}` (worker yazar, aynı indekste değiştirir) ve `consent {consentId, tool, title, detail,
  state pending|allowed|denied|expired, decidedAt}`. Worker kartı `pending` yazar; sahip
  `POST /api/conversations/{id}/messages/{messageId}/consent {consentId, allow}` ile cevaplar (aynı karar etkisiz,
  farklısı `409`, `expired` kart `409`; soru cevabından farklı olarak yeni tur başlatmaz). Karar verilmiş/süresi
  dolmuş kart worker'ın `part.set`'iyle değişmez. Tur biterken (tamamlanma, hata, iptal) bekleyen kartlar `expired`.
- **Worker okuması:** `GET /api/worker/runs/{runId}/message` → `{run, message}` (soru/izin beklerken yoklanır).
- **Oturum:** `complete {session: {id}}` → konuşmada `agentSession {id, messageCount, runId, updatedAt}`
  (`messageCount` o anki mesaj sayısı; migration `0007_agent_session`). `TurnContext.messageCount` konuşmanın tüm
  mesaj sayısı; worker oturumu yalnızca arada başka bir şey olmadıysa sürdürür.
- **Claude girişi:** worker `worker.claude` çerçevesiyle `claude auth status`'u bildirir (presence `claude`, DO
  deposunda kalıcı). `GET /api/workers/claude`, `POST /api/workers/claude/login` (yalnızca Mac'in kendisi,
  `requireLocal`) ve `POST …/status` hub üzerinden worker'a `worker.command` gönderir; bağlı worker yoksa `409`.

## Görsel takma adları ve @anmalar (A2b)

Sohbette eklenen her dosya konuşma içinde bir takma ad alır; kullanıcı metinde `@image-1` diye o dosyayı
işaret eder. Şemalar ve yardımcılar: `packages/contract/src/chat-alias.ts`.

### Kurallar

- **Ad biçimi:** 1–40 karakter, `a-z`, `0-9` ve `-`; harfle başlar, `-` ile bitmez. Girdi küçük harfe
  çevrilir (`Kapak` → `kapak`), yani karşılaştırma büyük/küçük harf duyarsızdır (`AttachmentAlias`).
- **Otomatik ad:** görsel `image`, `image-1`, `image-2`, …; video `video…`, ses `audio…`, diğerleri `file…`
  (mime türüne göre, `aliasBaseFor`). Her zaman o tabanın konuşmada **hiç kullanılmamış** en küçük adı
  verilir. Adlar asla serbest kalmadığı için numara yalnızca ileri gider: yeniden adlandırılan ya da mesajı
  silinen bir ekin adı başka bir dosyaya verilmez.
- **Bir varlık, bir ad:** aynı varlık konuşmada tekrar eklenirse ilk adını korur (ek parçası aynı `aliasId`'yi
  taşır). Ajanın `part.set` ile eklediği dosyalar da ad alır (ör. üretilen görsel `image-2`).
- **İstenen ad:** `attachments: [{ assetId, alias? }]` ile istemci ad isteyebilir. Ad başka bir takma ada ait
  ya da daha önce aitse `409 conflict`; varlığın zaten başka bir adı varsa (kendi eski/güncel adları hariç)
  `409`. Aynı mesajda önce istenen adlar ayrılır, sonra otomatik adlar verilir. `attachmentAssetIds` aynen
  çalışır; ikisi birlikte gönderilemez (`400`).
- **Ek kuralı değişmedi:** yalnızca konuşmanın markasına ait var olan varlıklar; markasız konuşmada ek `400`.
- **Yarışsızlık:** ayırma Hub'ın seri kuyruğunda, mesajla aynı D1 batch'inde yazılır; benzersiz indeksler
  (ad, varlık, ad geçmişi) ikinci güvence.

### @anmalar

Kullanıcı mesajı kaydedilirken metindeki `@ad` parçaları konuşmanın takma adlarına (güncel ve eski adlar)
çözülür ve `message.mentions` olarak saklanır; bilinmeyen `@ad` düz metin kalır ve listelenmez.

- `@` metnin başında ya da boşluk/noktalama sonrasında olmalı: `a@image`, `x.y@image`, `…/@image` eşleşmez.
- Ad, `@`'ten sonraki en uzun `A-Z a-z 0-9 -` dizisidir (sondaki `-` atılır): `@image-10` her zaman
  `image-10`'dur, asla `image-1` + "0" değildir; `@image-100` (öyle bir ad yoksa) hiçbir şeye çözülmez.
- Addan hemen sonra harf/rakam gelirse eşleşmez (`@imageım`); noktalama serbest: `@image,` `@image-1'i` `(@image)`.
- Her geçiş ayrı listelenir (tekrarlar dahil), metin sırasıyla.
- İstemci yazarken aynı sonucu `resolveAliasMentions(text, aliases)` ile vurgulayabilir; kaydedilen sunucunun sonucudur.

### Biçim (wire format)

```jsonc
// POST /api/conversations/{id}/messages
{ "text": "@image-1 görselini ürün postunda kullan, @image kapak olsun",
  "attachments": [{ "assetId": "…" }, { "assetId": "…", "alias": "urun" }],   // ya da attachmentAssetIds
  "clientMessageId": "ios-42" }

// message.parts[] içindeki ek
{ "type": "attachment", "assetId": "…", "kind": "image", "mimeType": "image/png", "width": 1080,
  "height": 1350, "filename": "tarla.png", "alias": "image", "aliasId": "…" }

// message.mentions[] (kullanıcı mesajında; diğer mesajlarda [])
{ "alias": "image-1", "aliasId": "…", "assetId": "…", "start": 0, "end": 8 }

// GET /api/conversations/{id}/aliases  → { "items": [ConversationAlias, …] } (eskiden yeniye, sayfasız)
{ "id": "…", "conversationId": "…", "alias": "kapak", "previousAliases": ["image-1"], "assetId": "…",
  "kind": "image", "mimeType": "image/png", "width": 1080, "height": 1350, "filename": "tarla.png",
  "contentPath": "/api/assets/{assetId}/content", "messageId": "…", "createdAt": "…", "updatedAt": "…" }

// PATCH /api/conversations/{id}/aliases/{aliasId}  { "alias": "kapak" }  → ConversationAlias
```

- `start`/`end` metin parçasındaki **UTF-16 kod birimi** konumlarıdır (JS dizgi indeksi; Swift'te
  `NSRange` / `String.utf16`), `end` hariç; aralık `@` dahil adı kapsar. `alias` yazıldığı hâliyle (küçük
  harf) addır; eski bir ad olabilir.
- `alias`, `aliasId` (ek parçasında) ve `mentions` alanları şemada isteğe bağlıdır (eski kayıtlar için);
  sunucu yeni yanıtlarda hep gönderir.

### Yeniden adlandırma ve gösterim

`PATCH …/aliases/{aliasId}` adı değiştirir; takma adın `id`'si aynı kalır, eski ad `previousAliases`'a geçer ve
o takma ada ayrılmış kalır (yeni metinde hâlâ çözülür, başka dosyaya verilmez). Aynı ad: değişiklik yok (200).
Başka bir takma adın güncel ya da eski adı: `409`. Takma ad kendi eski adına geri dönebilir.

**Kayıtlı mesajlar değişmez** (metin, ek parçasındaki `alias`, mention'daki `alias`). İstemci gösterirken:
ek parçası ve mention için `aliasId` ile konuşmanın takma ad listesinden **güncel adı** bulur; mention
aralığındaki metni (`text.slice(start, end)`) `@` + güncel ad olarak çizer. `aliasId` bulunamazsa (eski
istemci durumu) saklanan `alias` gösterilir.

### Worker bağlamı

`start` ve `GET …/context` yanıtındaki `TurnContext` artık `aliases` taşır: konuşmanın **tüm** takma adları
(son 100 mesajın dışındakiler dahil), `ConversationAlias` alanları + `objectKey` (R2 anahtarı) ile
(`TurnAlias`). `messages[].mentions[].aliasId` bu listeye çözülür; ajan yalnızca anılan görselleri
`objectKey` ya da `contentPath` ile yükleyebilir.

### Akış

Yeni çerçeve türü **eklenmedi** (kendi bilmediği türü atan bir istemci `seq` boşluğu görüp sürekli yeniden
bağlanırdı). Bunun yerine `conversation.updated` çerçevesine isteğe bağlı `aliases` alanı eklendi: bu
değişiklikte eklenen ya da yeniden adlandırılan takma adlar (`id` ile upsert). Mesaj gönderiminde zaten
giden `conversation.updated` bunu taşır; ajan ek eklediğinde ve yeniden adlandırmada ayrıca bir
`conversation.updated` gider. `conversation.snapshot` tam listeyi `aliases` olarak taşır. Referans
indirgeyici `state.aliases`'ı tutar (snapshot'tan alır, `conversation.updated.aliases` ile upsert eder).

## Migration

Şema `src/db/schema.ts`. Migration SQL'leri `migrations/` altında (`0000_init`, `0001_core_model`, `0002_job_queue`, `0003_chat`, `0004_attachment_aliases`, `0005_run_model_effort`, `0006_devices`, …).
`0002` yalnızca `jobs` tablosuna sütun ve indeks ekler (tablo yeniden kurulmaz); yeni sütunların aralıkları API'de doğrulanır.
`0003` yalnızca yeni tablolar ekler (konuşmalar, mesajlar, turlar, akış olayları, planlar, plan kalemleri).
`0004` iki yeni tablo (`conversation_aliases`, `conversation_alias_names`) ve `messages.mentions` sütununu ekler (null = anma yok).

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
test D1'ine uygular; R2 ve Durable Object da yerelde taklit edilir. Testlerde `WORKER_TOKEN` değeri `vitest.config.ts` içinde verilir. Testlerin soketi olmadığı için istekler `test/helpers.ts` → `localFetch` ile `CF-Connecting-IP: 127.0.0.1` taşır (Mac'in kendisi gibi).
Dosyalar: `api.test.ts` (sağlık, OpenAPI, şema, hub), `devices` (erişim matrisi: yerel, geçitten sahte 127.0.0.1, adres yok, worker anahtarı, cihaz anahtarı, iptal edilmiş anahtar, WebSocket; eşleştirme: mutlu yol, süresi dolmuş/tekrar kullanılan/yerine yenisi gelen kod, adres başına ve toplam hız sınırı, yalnızca hash saklanması), `brands`, `brand-profiles`, `assets`, `contents` (onay hash kuralı dahil),
`jobs-schedules`, `hub` (yetkilendirme, bağlanınca dağıtım, öncelik/FIFO/kapasite, kiralama dolması ve yeniden kuyruk,
en fazla deneme, heartbeat, tekrarlanan mesajlar, iptal, kopukken üretilen sonuç, Hub yeniden başlaması ve tahliye,
düzgün kapanış, canlı akış), `chat` (tam akış: mesaj → tur + iş → worker deltaları ve plan → istemci akışı
sırayla → kabul → içerikler → üretim işleri; tek etkin tur, tur ortasında iptal, yinelenen/boşluklu delta,
iptalden sonra yazma, yanlış marka eki, eşzamanlı mesaj, `after` ile devam ve Hub yeniden başlaması, soru cevabı,
plan düzenleme/ret/geçersizleşme, iş kaybında tur durumu, worker token'ı), `aliases` (ayırma sırası, yeniden
adlandırmadan sonra adın tekrar verilmemesi, istenen ad çakışmaları, eşzamanlı gönderim ve yeniden adlandırma,
mention ayrıştırma, worker bağlamı ve akış).

Elle deneme (API çalışırken, `pnpm dev`):

```sh
B=$(curl -s -X POST localhost:8787/api/brands -H 'content-type: application/json' -d '{"name":"Deneme"}' | jq -r .id)
C=$(curl -s -X POST localhost:8787/api/contents -H 'content-type: application/json' \
  -d "{\"brandId\":\"$B\",\"type\":\"post\",\"title\":\"İlk post\",\"targetPlatforms\":[\"instagram\"]}" | jq -r .id)
H=$(curl -s -X POST localhost:8787/api/contents/$C/versions -H 'content-type: application/json' \
  -d '{"origin":"generated","slides":[{"html":"<html></html>","width":1080,"height":1350}]}' | jq -r .contentHash)
curl -s -X POST localhost:8787/api/contents/$C/approve -H 'content-type: application/json' -d "{\"hash\":\"$H\"}"
```
