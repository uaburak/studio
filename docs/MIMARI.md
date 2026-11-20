# Studio mimarisi (tek sayfa)

Studio tek kişilik bir sosyal medya içerik stüdyosudur. Her şey sahibin Mac'inde çalışır: veri,
yapay zekâ üretimi, render ve (Mac açıksa) yayın. Bulutta yalnızca isteğe bağlı **bulut yayıncı**
vardır; Mac uyurken zamanı gelen postları o paylaşır. iPhone uygulaması Mac'e yerel ağdan, evin
dışındaysa Cloudflare Tunnel üzerinden bağlanır.

```
 iPhone (StudioIOS, UIKit)
   │  yerel ağ: Bonjour _studio._tcp → :8791      ev dışı: https://<tünel adresi>
   ▼                                               │ (cloudflared → :8791)
┌──────────────────────────── Mac: Studio.app (Electron) ─────────────────────────────┐
│ ana süreç: pencereler, studio:// protokolü, sahip anahtarı, ayarlar, yedek, bildirim │
│   ├─ API         wrangler dev / workerd   127.0.0.1:8790   D1 · R2 · Hub (DO)          │
│   ├─ LAN geçidi  lan-gateway.mjs          0.0.0.0:8791 → 127.0.0.1:8790              │
│   ├─ worker      Node                     Hub'a WebSocket (WORKER_TOKEN)              │
│   ├─ tuval çalıştırıcısı (gizli pencere)  Hub'a ayrı bağlantı, yalnızca canvas.* işleri│
│   └─ cloudflared (uzaktan erişim açıksa)                                             │
└───────────────────────────────────────────────┬──────────────────────────────────────┘
                                                │ yayın siparişi (isteğe bağlı)
                                                ▼
                        bulut yayıncı (Cloudflare Worker + Durable Object + R2)
                                                │
                                                ▼
                               Instagram · Facebook · LinkedIn
```

## Süreçler

| Süreç               | Kod                                                                          | Ne yapar                                                                                                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Masaüstü uygulaması | `apps/desktop` (Electron + React)                                            | Arayüz; sunucuyu başlatır, gözetir, çökeni geri çekilmeyle yeniden başlatır, kapanışta durdurur (`src/main/host/`).                                                                                             |
| API                 | `apps/api` (Hono, Cloudflare Workers çalışma zamanı, yerelde `wrangler dev`) | Tüm veri ve iş akışı. D1 (SQLite), R2 (medya), `Hub` Durable Object (iş kuyruğu dağıtımı, canlı akışlar).                                                                                                       |
| LAN geçidi          | `apps/api/scripts/lan-gateway.mjs`                                           | Telefonların ve tünelin tek girişi. Gerçek istemci adresini yazar, `X-Studio-Gateway: 1` ekler; geçitten gelen istek asla "yerel" sayılmaz.                                                                     |
| Worker              | `apps/worker` (Node)                                                         | Üretim işlerini çalıştırır: sohbet ajanı (Claude Code, Gemini, Codex, OpenAI, Antigravity), içerik üretimi, Chromium ile render, Reels (ffmpeg, whisper, seslendirme), görsel üretimi, kontroller, yerel yayın. |
| Tuval çalıştırıcısı | `apps/desktop/src/main/canvas/` + `src/renderer/canvas-runner.ts`            | Gizli bir Electron penceresinde Wecra motoru; `canvas.read` / `canvas.apply` işlerini alır (yapay zekâ tuval belgesini Wecra'nın kendi tasarım işlemleriyle düzenler). İlk işte açılır, boşta kapanır.          |
| cloudflared         | Homebrew                                                                     | Yalnızca Ayarlar → Gelişmiş → Uzaktan erişim açıksa; tünel adresi ve anahtarı orada girilir (varsayılan adres yoktur).                                                                                          |
| MCP sunucusu        | `apps/mcp` (Node, stdio)                                                     | Claude Code ve diğer ajanlar için: yerel API'yi sahip anahtarıyla, yalnızca loopback üzerinden kullanır; tehlikeli işlemler `confirm: true` ister. Ayrıntı: [apps/mcp/README.md](../apps/mcp/README.md).        |
| Bulut yayıncı       | `apps/cloud-publisher`                                                       | Mac'in gönderdiği yayın siparişlerini zamanında paylaşır. Ayrıntı: [apps/cloud-publisher/README.md](../apps/cloud-publisher/README.md).                                                                         |

Geliştirmede alt süreçler depodan (`tsx`, `wrangler dev` kaynak dosyalardan), paketlenmiş
Studio.app'te uygulamanın içindeki derlenmiş kopyalardan çalışır: [PACKAGING.md](PACKAGING.md).

## Portlar

| Port | Ne                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------- |
| 8790 | API, yalnızca `127.0.0.1` (doluysa boş bir port seçilir; `host.json`'a yazılır)                |
| 8791 | LAN geçidi, `0.0.0.0` (Ayarlar'dan kapatılabilir)                                              |
| 8793 | Meta / LinkedIn hesap bağlama dönüşü (`http://localhost:8793/...`), yalnızca bağlama sırasında |
| 5183 | Geliştirmede arayüzün Vite sunucusu (`pnpm dev`); paket `studio://app` kullanır                |
| 8787 | Yalnızca API'yi elle çalıştırırken (`pnpm --filter @studio/api dev`)                           |

## Veri nerede

Hepsi `~/Library/Application Support/Studio` altında (geliştirme ve paket aynı klasörü kullanır):

| Yol                                              | İçerik                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `api/state/v3/`                                  | D1 veritabanı, R2 medya dosyaları, Durable Object durumu (`wrangler --persist-to`)                 |
| `backups/`                                       | Göçten önce otomatik veritabanı kopyası; Ayarlar → Gelişmiş → Yedekle / Geri yükle                 |
| `worker/`                                        | Worker'ın çalışma klasörü (sohbet oturumları, önbellek)                                            |
| `logs/`                                          | Her sürecin logu, `desktop.log`, `crashes/` (yalnızca yerel)                                       |
| `host-secrets.json`                              | `WORKER_TOKEN` ve token kasası anahtarı (`TOKEN_ENCRYPTION_KEY`), Electron safeStorage ile şifreli |
| `owner-secret`                                   | Sahip anahtarı (0600)                                                                              |
| `desktop-secrets.json`                           | Meta App Secret, LinkedIn Client Secret, tünel anahtarı (safeStorage ile şifreli)                  |
| `worker-env.json`                                | Worker anahtarları (ElevenLabs vb.), safeStorage ile şifreli                                       |
| `desktop-settings.json`, `desktop-accounts.json` | Ayarlar; Meta App ID ve LinkedIn Client ID                                                         |
| `host.json`, `host.lock`, `instance-id`          | Çalışan sunucunun portları ve sahibi; tek sunucu kilidi; bu Mac'in kimliği                         |
| `browsers/`, `runtime/`, `drafts/`               | İndirilen Chromium, paketin wrangler dosyaları, tuval taslak yedekleri                             |

Sosyal hesap token'ları API'nin D1'inde, AES-256-GCM ile şifreli (token kasası) durur. iPhone'un
cihaz anahtarı telefonun Anahtar Zinciri'ndedir.

## Kimlik doğrulama

API'nin tek giriş noktası `apps/api/src/middleware/access.ts`. Üç kimlik vardır:

- **local** (sahip): yalnızca masaüstü uygulaması. Beş koşulun hepsi gerekir: geçit işareti yok,
  istemci adresi loopback, `Host` `127.0.0.1` / `localhost` / `[::1]`, `Origin` varsa `studio://app`
  ya da loopback, ve `X-Studio-Owner` başlığı `STUDIO_OWNER_SECRET`'e eşit. Anahtarı ana süreç üretir
  ve yalnızca ana süreç ekler (sayfaların isteklerine de); tarayıcıdaki bir web sayfası bu yüzden
  Studio'yu kullanamaz.
- **worker**: `Authorization: Bearer <WORKER_TOKEN>`. Worker ve tuval çalıştırıcısı; Hub ve
  `/api/worker/*` uçları bunu ister.
- **device**: eşleşmiş iPhone, `Authorization: Bearer <cihaz anahtarı>`. Eşleştirme Mac'te QR kodu
  ya da 6 haneli kodla yapılır; sunucu anahtarın yalnızca SHA-256'sını tutar. İptal edilen cihazın
  açık akışları anında kapanır. Cihaz yönetimi ve bazı kararlar (ör. Claude sınırı) yalnızca `local`.

`GET /api/health` ve `POST /api/pairing/claim` herkese açıktır (claim hız sınırlı). Sağlık ucu Mac'e,
worker'a ve eşli cihazlara bileşen ayrıntısı da verir (veritabanı, göç seviyesi, medya, worker, tuval
çalıştırıcısı, kasa, bulut yayıncı, tünel).

## İşler

D1 `jobs` tablosu tek doğru kaynaktır; Hub işleri bağlı worker'lara dağıtır (kiralama, heartbeat,
yeniden deneme, iptal). Türler (`packages/contract/src/job.ts`):

| Tür                           | Ne                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.turn`                   | Sohbet ajanının bir turu (araçlı; Studio araçları MCP köprüsüyle)                                                                        |
| `content.generate`            | Post / carousel / story / Reels üretimi (eleştiri turu ve kontrollerle); şablondan doldurma (N9), post → story / Reels dönüştürme (N10)  |
| `content.render`              | HTML slaytları Chromium ile JPEG / PNG / PDF'e, Reels'i MP4'e                                                                            |
| `content.check`               | Üretim kontrolleri (taşma, güvenli alan, kontrast, yasaklı kelime, marka uyumu…) ve düzeltme                                             |
| `image.generate`              | Yapay zekâ görseli (Gemini / OpenAI); ürün etiketi korumalı birleştirme ve doğrulama (U9)                                                |
| `media.analyze`               | Yüklenen görselleri Mac'te Apple Vision ile etiketleme: etiket, yazı, renk, benzerlik (N12)                                              |
| `brand.analyze`               | Marka kiti ve örneklerden marka profili                                                                                                  |
| `brand.skill_draft`           | Geçmiş postlardan marka skill taslağı                                                                                                    |
| `schedule.publish`            | Mac'ten yerel yayın (Meta, LinkedIn)                                                                                                     |
| `canvas.read`, `canvas.apply` | Tuval belgesini okuma / düzenleme (yalnızca tuval çalıştırıcısı)                                                                         |
| `insights.sync`               | Yayınlanan Instagram / Facebook postlarının istatistikleri (1 / 24 / 72 saat sonra, sonra günlük, 90 gün) ve günlük takipçi sayısı (N15) |
| `comments.sync`               | Bekleyen yorum yanıtlarını / gizle / sil işlemlerini gönderir, son 30 günün postlarındaki yeni yorumları okur (15 dakikada bir, N16)     |
| `comments.suggest`            | "Yanıt öner": markanın sesiyle yanıt taslağı; asla kendiliğinden gönderilmez (N16)                                                       |
| `demo.echo`                   | Duman testi                                                                                                                              |

Mac kapalıyken iPhone'dan gelen istekler kuyrukta bekler; Mac açılınca işlenir.

`insights.sync` ve `comments.sync`'i Hub kendisi kuyruğa alır (alarmı worker bağlıyken dakikada bir
çalışır; en çok 5 dakikada bir bakar, aynı türden ikinci bir iş açmaz). Neyin zamanı geldiğine API
karar verir (`/api/worker/engagement/*`); worker yalnızca okur ve bildirir. Webhook yok (açık adres
gerekir; ileride tünel üzerinden olabilir), yorumlar yoklamayla okunur. LinkedIn kişisel profil
istatistikleri API'de neredeyse yok; okunmaz.

## Post ve tuval

İçerik sürümlüdür; her sürümün slaytları HTML'dir (`packages/design-kit` sözleşmesi). Post tuvalde
(Wecra düzenleyicisi, kapalı kaynak, `apps/desktop/src/renderer/vendor/wecra-editor`, git'e girmez)
açılınca **Wecra belgesi asıl kaynak** olur (S1); slaytların PNG'leri ve katman bilgisi ondan çıkar.
Otomatik kayıt tek taslağı günceller; sürüm yalnızca ⌘S, onay, zamanlama ve sohbet düzeltmesinde
oluşur (S5). Onay, içerik hash'ine bağlıdır: "neyi onayladıysam o paylaşılır".

## Yayın

- **Yerel mod**: zamanı gelen post Mac'teki worker'dan paylaşılır (`schedule.publish`); Mac uyuyorsa
  kaçar ve gecikme sınırından (varsayılan 2 saat) sonra paylaşılmaz, bildirilir.
- **Bulut modu**: onaylı zamanlama, işlenmiş medyası ve token'ıyla bulut yayıncıya sipariş olarak
  gider; Mac açıldığında sonucu çeker. Adres ve `PUBLISHER_TOKEN` Ayarlar → Yayın'dan girilir.
- Yayıncılar: `packages/publishers` (Instagram, Facebook, LinkedIn durum makineleri).
- Yayın ayrıntıları (N13): ilk yorum (yayından sonra ayrı adım; başarısız olursa post yayında kalır,
  uyarı yazılır), alternatif metin, konum, ortak paylaşım, kişi etiketi, Reels kapağı, akışta da
  göster. Postta durur (`PUT /api/contents/{id}/publish-details`), onayı geri almaz; bekleyen
  zamanlamaların bulut siparişi yeniden gönderilir. Platform desteği: `PUBLISH_DETAIL_SUPPORT`.

## iPhone

`apps/apple/StudioIOS` (UIKit) ve ortak çekirdek `apps/apple/StudioKit` (Swift paketi). Telefon
Mac'i Bonjour'la ya da kayıtlı yerel adreslerle bulur, bulamazsa tünel adresini dener. Sohbet,
postlar, onay, zamanlama, takvim ve bildirimler; tuvalde düzenlenmiş postlar telefonda salt-okunurdur.
Ayrıntı: [apps/apple/README.md](../apps/apple/README.md).
