# @studio/cloud-publisher

Studio'nun buluttaki **tek** parçası. Her şey (API, veriler, üretim) Mac'te çalışır; Mac kapalı ya da uykudayken de onaylanıp zamanlanan postların saatinde paylaşılması gerektiği için yalnızca **yayın** buluta taşındı.

Mac bu Worker'a bir **yayın siparişi** (publish order) gönderir: içerik ve sürüm kimliği, içerik hash'i, hedefler (Instagram / Facebook Sayfası), hesabın Meta kimliği, UTC yayın zamanı, metin, alternatif metin, işlenmiş medya dosyaları ve erişim anahtarı (token). Worker zamanı gelince `@studio/publishers` durum makineleriyle paylaşır. Mac çevrimiçi olduğunda durumu ve yayın kaydını kendisi çeker; Worker Mac'e hiçbir şey göndermez.

Henüz dağıtılmadı. Cloudflare'de hiçbir kaynak oluşturulmadı (bkz. "Kurulum").

## Tasarım

| Konu           | Karar                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kalıcı depo    | **Tek bir Durable Object** (`Scheduler`, SQLite). D1 + cron yerine seçildi: alarm tam zamanında uyandırır (cron dakikalık), nesne her seferinde tek olay işlediği için aynı sipariş iki kez aynı anda sürülemez (kiralama/kilit sorgusu gerekmez), yazmalar bir sonraki dış istek çıkmadan kalıcı olur ("önce kaydet, sonra davran" kuralı tam olarak bu). D1 veritabanı oluşturmaya gerek kalmaz. Günde birkaç post için tek nesne fazlasıyla yeter. |
| Uyanma         | Birincil: DO **alarmı**, bir sonraki iş zamanına kurulur. Yedek: **5 dakikada bir cron**, nesneyi dürter (kaybolan alarm hiçbir postu bekletmez). Bir uyanma adım ortasında ölürse 60 sn sonrası için bekçi alarmı kuruludur.                                                                                                                                                                                                                         |
| Durum makinesi | Hedef zamanı gelince `publisher.start(request)` ile başlar; her uyanmada `publisher.step` çağrılır ve **sonuç, başka hiçbir şey yapılmadan önce** kaydedilir. `continue` hemen sonraki adım, `wait` `resumeAt` anında (konteyner yoklama, hız sınırı), `done` yayınlandı, `failed` aşağıdaki kurala göre.                                                                                                                                             |
| Çökme          | Adımın Graph çağrısı yapılıp sonucu kaydedilemeden ölünürse sonraki uyanma son kaydedilen durumdan devam eder. Paket yayın çağrısından önce platformu kontrol eder; aynı şey iki kez paylaşılmaz (testte her adımda çökme denendi).                                                                                                                                                                                                                   |
| Hatalar        | Geçici hatalar ve hız sınırları paketin `wait` sonucuyla yeniden denenir. Paket pes edip **yeniden denenebilir** hata dönerse (ör. `PROCESSING_TIMEOUT`) sürücü 15 dk sonra (kota dolduysa 1 saat sonra) yeniden başlatır, en fazla 6 kez. Diğerleri (`TOKEN_INVALID`, `MEDIA_REJECTED`, `PUBLISH_UNCERTAIN` …) kalıcı hata: hedef `failed` olur, token silinir.                                                                                      |
| Medya          | Dosyalar Worker'ın kendi R2 kovasında (`orders/{siparişId}/{sha256}`). Instagram görseli URL'den çektiği için `/media/{sipariş}/{bitiş}/{imza}/{dosya}` yolundan sunulur: HMAC-SHA256 imzalı, yayın başladıktan **24 saat** sonra geçersiz. İptal edilen siparişin medyası hemen, biten siparişinki 3 gün sonra silinir. Yükleme, bildirilen tür, boyut ve SHA-256 ile doğrulanır (R2 hash'i sunucu tarafında kontrol eder).                          |
| Token          | AES-256-GCM (WebCrypto), anahtar `TOKEN_ENCRYPTION_KEY` gizlisinden. Her şifreli metin kendi satırına bağlı (ek doğrulama verisi: sipariş + hedef kimliği). Yalnızca adım anında çözülür, hiçbir yanıtta dönmez, hiçbir loga yazılmaz; hedef bitince silinir.                                                                                                                                                                                         |
| Loglar         | `console.log` yalnızca kimlik ve hata kodu yazar (token, metin, URL yok). Graph istemcisinin logları paket tarafından zaten temizlenmiş halde gelir.                                                                                                                                                                                                                                                                                                  |

## Uçlar

`/v1/*` her istekte `Authorization: Bearer <PUBLISHER_TOKEN>` ister (sabit sürede karşılaştırılır); yoksa `401 unauthorized`. Hata gövdesi her zaman `{ "error": { "code", "message", "issues?" } }`. Şemalar: `packages/contract/src/cloud-publisher.ts`.

| Yöntem ve yol                                         | Ne yapar                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /v1/orders/{orderId}`                            | Sipariş oluşturur (`201`) ya da **yayın başlamadan** değiştirir (`200`). Gövde `CloudOrderCreate`. Zaman gelecekte olmalı; içerik `@studio/publishers` kurallarıyla önceden denetlenir (`400` + `issues`). Başlamış ya da iptal edilmiş siparişe `409`. Aynı SHA-256'lı dosyalar yeniden yüklenmez. |
| `PUT /v1/orders/{orderId}/media/{mediaId}`            | Dosyanın baytları (ham gövde). `Content-Type` ve `Content-Length` bildirilenle aynı olmalı (`415` / `400`), SHA-256 tutmalı (`400`). Tüm dosyalar yüklenince durum `scheduled` olur.                                                                                                                |
| `POST /v1/orders/{orderId}/cancel`                    | Yayın başlamadıysa iptal eder, medyayı siler (tekrarı zararsız). Başladıysa `409`.                                                                                                                                                                                                                  |
| `GET /v1/orders/{orderId}`                            | `CloudOrder`: durum, hedefler (deneme sayısı, sonraki çalışma, dış kimlik, gönderi kimliği, kalıcı bağlantı, hata). Token yok.                                                                                                                                                                      |
| `GET /v1/orders?status=&updatedSince=&limit=&cursor=` | `updatedAt`'e göre artan sıralı liste; Mac `updatedSince` ile yalnızca değişenleri çeker, `nextCursor` ile sayfalar.                                                                                                                                                                                |
| `GET /v1/orders/{orderId}/log`                        | Yayın kaydı: `started`, `retry_scheduled` (hata + yeni zaman), `succeeded` (dış kimlik, bağlantı), `failed`, `cancelled`.                                                                                                                                                                           |
| `GET/HEAD /media/{orderId}/{exp}/{sig}/{mediaId}`     | Herkese açık ama imzalı (Meta indirir). Geçersiz imza `403`, süresi dolmuş `410`, iptal/silinmiş `404`. `Range` destekli.                                                                                                                                                                           |
| `GET /health`                                         | Kimlik doğrulamasız canlılık, veri yok.                                                                                                                                                                                                                                                             |

**Sipariş durumları:** `awaiting_media` → `scheduled` → `publishing` → `published` / `partially_published` / `failed`; ya da `cancelled`. Hedef durumları: `pending`, `publishing`, `published`, `failed`, `cancelled`.

**Hedef türleri (`kind`):** `instagram.image`, `instagram.carousel` (2–20 öğe), `instagram.reel`, `instagram.story`, `facebook.photo`, `facebook.multi_photo`, `facebook.video`, `facebook.reel`, `facebook.story`. Tek medyalı türler ilk dosyayı kullanır. Instagram için kullanıcı token'ı, Facebook için **Sayfa token'ı** gönderilmeli.

## Gizli anahtarlar ve değişkenler

| Ad                     | Tür                  | Ne                                                                                                                                        |
| ---------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLISHER_TOKEN`      | gizli (zorunlu)      | Mac ile paylaşılan taşıyıcı anahtar. Mac'te Anahtar Zinciri'nde durmalı.                                                                  |
| `TOKEN_ENCRYPTION_KEY` | gizli (zorunlu)      | 32 rastgele baytın base64'ü (`openssl rand -base64 32`). Değişirse kayıtlı token'lar çözülemez; bekleyen siparişler yeniden gönderilmeli. |
| `MEDIA_URL_SECRET`     | gizli (zorunlu)      | Medya URL imzası için HMAC anahtarı.                                                                                                      |
| `META_APP_SECRET`      | gizli (isteğe bağlı) | Meta uygulamasında "Require App Secret" açıksa; her çağrıya `appsecret_proof` eklenir.                                                    |
| `PUBLIC_BASE_URL`      | değişken             | Meta'nın medyayı indireceği adres (ör. `https://publish.burakkoc.net`). `wrangler.jsonc` içinde.                                          |

Yerelde: `.dev.vars.example` dosyasını `.dev.vars` olarak kopyalayın.

## Mac bunu nasıl kullanıyor (P3)

Adres ve `PUBLISHER_TOKEN` Mac'te Ayarlar → Yayın'dan girilir (API kasasında saklanır, worker `GET /api/worker/publishing/config` ile okur). Worker her 30 sn'de ve uygulama öne gelince aşağıdakileri yapar; zamanlamanın durumu takvimde "Bulutta" olarak görünür.

1. İçerik onaylanıp zamanlanınca Mac `PUT /v1/orders/{scheduleId}` gönderir (sipariş kimliği = Mac'teki zamanlama kimliği, böylece tekrar göndermek zararsız), ardından her dosyayı `PUT …/media/{mediaId}` ile yükler.
2. Zaman ya da içerik değişirse aynı kimlikle yeniden `PUT`; zamanlama geri çekilirse `POST …/cancel`. İkisi de yalnızca yayın başlamadan çalışır.
3. Mac token'ları yenilediğinde bekleyen siparişleri yeni token'la yeniden göndermeli (uzun ömürlü kullanıcı token'ı ~60 gün).
4. Mac her açıldığında `GET /v1/orders?updatedSince=<son eşitleme>` ile değişenleri çeker; `published` hedeflerin dış kimliği ve bağlantısını, `failed` hedeflerin hata kodunu yerel `schedules` / `publish_logs` kayıtlarına yazar. Ayrıntı için `…/log`.
5. Başarısız bir sipariş yeniden denenmez; Mac (kullanıcı onayıyla) yeni kimlikli bir sipariş açar. `PUBLISH_UNCERTAIN` gelirse önce elle kontrol gerekir.

## Cloudflare Access

Access bu alan adının önüne konursa:

- `/v1/*`: **servis token'ı** politikası. Mac `CF-Access-Client-Id` / `CF-Access-Client-Secret` başlıklarını da gönderir. Taşıyıcı anahtar kontrolü ek savunma olarak kalır (`src/app.ts` başındaki not).
- `/media/*`: **Bypass** politikası şart. Meta'nın sunucuları Access'ten geçemez; burayı imza korur.
- `/health`: isteğe bağlı bypass.

## Kurulum (tek seferlik, Burak yapacak; ajanlar dağıtmaz)

```sh
cd apps/cloud-publisher
pnpm exec wrangler login

# 1) Medya kovası
pnpm exec wrangler r2 bucket create studio-publisher-media

# 2) Gizliler. PUBLISHER_TOKEN değerini önce üretip Mac'in Anahtar Zinciri'ne de kaydedin.
openssl rand -hex 32            # çıktıyı kopyalayın: PUBLISHER_TOKEN
pnpm exec wrangler secret put PUBLISHER_TOKEN
openssl rand -base64 32 | pnpm exec wrangler secret put TOKEN_ENCRYPTION_KEY
openssl rand -hex 32 | pnpm exec wrangler secret put MEDIA_URL_SECRET
# isteğe bağlı: pnpm exec wrangler secret put META_APP_SECRET
# (Worker henüz yoksa wrangler oluşturmayı önerir: evet.)

# 3) wrangler.jsonc: PUBLIC_BASE_URL'i gerçek adrese çevirin. Özel alan adı için:
#    "routes": [{ "pattern": "publish.burakkoc.net", "custom_domain": true }]
#    (ya da workers.dev adresi: https://studio-cloud-publisher.<hesap>.workers.dev)

# 4) Dağıtım
pnpm run build                  # kuru çalıştırma, bir sorun var mı bakın
pnpm exec wrangler deploy

# 5) Kontrol
curl https://publish.burakkoc.net/health
curl -H "Authorization: Bearer <PUBLISHER_TOKEN>" https://publish.burakkoc.net/v1/orders
```

Durable Object (SQLite), cron ve R2 Workers ücretsiz planında da var. Dağıtımda `Scheduler` nesnesi `wrangler.jsonc` içindeki `exports` ile otomatik oluşur.

## Test

```sh
pnpm --filter @studio/cloud-publisher test        # workerd içinde, sahte Graph API ile
pnpm --filter @studio/cloud-publisher typecheck
pnpm --filter @studio/cloud-publisher build       # wrangler deploy --dry-run
```

Testler `@studio/publishers/testing` içindeki `FakeGraph` ve sahte saatle çalışır (gerçek ağ yok): sipariş yaşam döngüsü, cron ve alarmla zamanında yayın, IG + FB tek siparişte, eksik medya, kalıcı hata (iptal edilmiş token), geçici hata, sürücü düzeyinde yeniden başlatma, dört tür için **her adımda çökme** sonrası tek yayın, kaybolan yayın yanıtı, değiştirme ve iptal (başlamadan önce / sonra), yükleme doğrulaması, listeleme ve sayfalama, token şifreleme ve token'ın hiçbir yanıtta/logda görünmemesi, imzalı URL (geçerli, kurcalanmış, süresi dolmuş, `Range`), yetkisiz istekler.

## Sınırlar ve gerçek Meta uygulamasıyla doğrulanacaklar

- Instagram'ın görseli bu Worker'ın imzalı URL'sinden (sorgu dizesi değil yol içinde imza, `.jpg` ile biten) sorunsuz indirdiği; Access varsa `/media/*` bypass'ının çalıştığı.
- Videolar da URL ile çekilir (rupload ile itme kullanılmıyor). Uzun Reels'te Meta'nın 24 saatlik URL süresi içinde indirdiği varsayılıyor.
- Facebook Reels için Sayfa başına 24 saatte 30 API yayını sınırı burada sayılmıyor (Mac tarafında planlamada dikkate alınmalı).
- Tek bir Worker isteği 100 MB ile sınırlı; dosya başına üst sınır 95 MB.
- `@studio/publishers` README'sindeki "Gerçek Meta uygulamasıyla doğrulanması gerekenler" listesi burada da geçerli.
