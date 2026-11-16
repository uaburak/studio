# Studio — Görev Panosu

Son güncelleme: 2026-11-16. Mimari ve kararlar için: [PLAN.md](PLAN.md).

## Yönetim ve Mimari Kuralları

- **Doğrulama:** Her görev bizzat test ve derleme çalıştırılarak doğrulandı (toplam **965 otomatik test** yeşil).
- **Gizlilik:** `.env` dosyası okunmaz; API anahtarları ve jetonlar hiçbir çıktıya/loga yazılmaz.
- **Git:** Burak isteyene kadar commit yapılmaz.
- **Apple Arayüz Kuralı:** SwiftUI tamamen kaldırıldı (`0` satır); macOS (`StudioMac`) **%100 saf AppKit**, iOS (`StudioIOS`) **%100 saf UIKit**, paylaşılan çekirdek (`StudioKit`) saf Foundation/Network/Security olarak inşa edildi.
- **Çift Yapay Zekâ Desteği:** Hem **Gemini** (`.env` `GEMINI_API_KEY` üzerinden doğrudan SSE akışlı API + kuruluysa `gemini` CLI) hem **Claude Code** (abonelikle `--resume` oturum sürdürme + Studio MCP araçları + uygulama içi giriş) desteklenir.

## Mimari: Önce Mac (L1–L3 & A5)

| No | Görev | Klasör | Durum |
|---|---|---|---|
| L1 | Mac'te yerel sunucu: Mac uygulaması API, LAN geçidi ve worker'ı başlatır ve gözetler (`.env` otomatik aktarılır); Bonjour (`_studio._tcp`) duyurusu; 6 haneli kodla cihaz eşleştirme ve cihaz jetonları | `apps/api`, `apps/worker`, `apps/apple`, `packages/contract` | **Tamam (denetlendi)** |
| L2 | Bulut yayıncı + Mac senkronizasyonu: zamanlanmış postları alan ve saatinde paylaşan Cloudflare Worker (`@studio/cloud-publisher`, Instagram + Facebook + LinkedIn) ve Mac worker'da 30 sn senkronizasyon + yerel doğrudan yayın yedeği | `apps/cloud-publisher`, `apps/worker/src/publish`, `packages/contract` | **Tamam (denetlendi)** — bulut dağıtımı Burak'ın `wrangler login` adımını bekliyor |
| A5 (Sohbet) | Sohbet ajanı Wecra yöntemiyle + Gemini: oturum sürdürme (`--resume`), Studio MCP ve fonksiyon araçları, canlı araç adımları (`tool_step`), onay kartları (`consent`), `/usage`, uygulama içi Claude girişi ve `.env` `GEMINI_API_KEY` + `gemini` CLI (`gemini-flash-lite`, `gemini-flash`, `gemini-pro`) | `apps/worker`, `apps/api`, `packages/contract`, `apps/apple` | **Tamam (denetlendi)** |
| L3 | Remote Control: Mac uygulamasında Uzaktan Erişim anahtarı, `cloudflared` tünel gözetmeni (`social.burakkoc.net`) ve Anahtar Zinciri tünel jetonu | `apps/apple/StudioMac` | **Tamam (denetlendi)** — canlı tünel için `cloudflared` jetonu girilmesi yeterli |

## Tüm Fazlar ve Altyapı / Uygulama Durumu (Faz 0 – Faz 6)

| No / Faz | Kapsam | Klasör | Durum |
|---|---|---|---|
| F0-1 .. F0-4 | Monorepo, tasarım kiti, HyperFrames video motoru karşılaştırması, Durable Object WebSocket hub | kök, `packages/design-kit`, `spikes/*` | **Tamam (denetlendi)** (`design-kit`: 357/357 test) |
| A1 / F1-2 | Tasarım kiti: HTML/CSS sözleşmesi, statik ve geometri denetleyicisi, katman yamaları, Chromium render ve çok sayfalı PDF | `packages/design-kit` | **Tamam (denetlendi)** |
| A2 / A2b / M2 | Sohbet altyapısı, `@takma-ad` görsel anmaları, model/efor ve kullanım limiti takibi | `apps/api`, `packages/contract` | **Tamam (denetlendi)** (`contract`: 122/122 test) |
| A4 / F1-3 | Worker üretim hattı: aylık plan, post/carousel/story üretimi, kalite/eleştiri döngüsü (Claude + Gemini yedekli) | `apps/worker/src/generate` | **Tamam (denetlendi)** |
| Faz 2 | **Görsel Editör, Yuva Doldurma & AI Görsel**: `content.render` ile gerçek yuva doldurma (`slotAssignments`), doğrudan `[data-layer]` katman düzenleme, `image.generate` ile 2K Gemini görsel üretimi + **ürün etiketi koruma (kesim + kompozit)**, medya kütüphanesi | `apps/worker/src/render`, `apps/worker/src/image`, `apps/apple`, `apps/web` | **Tamam (denetlendi)** |
| A5 / F1-4 & Faz 6 | **Marka Profili & Geri Besleme**: marka kiti/görsel analizi + onaylanmış post ve düzenleme geçmişinden ton/tasarım geri beslemesi (`brand.analyze`), `brand.json` / `DESIGN.md` / `VOICE.md` sürümleme ve onay | `apps/worker/src/brand`, `apps/api`, `apps/apple`, `apps/web` | **Tamam (denetlendi)** |
| A6 / Faz 3 | **Yayın Motoru, Token Kasası & Takvim**: AES-256-GCM şifreli `social_account_tokens` kasası (`0008_token_vault.sql`), Meta Sayfa/IG keşfi, LinkedIn bağlantısı, token sağlık kontrolü, zamanlayıcı ve aylık Takvim ekranı | `apps/api`, `packages/publishers`, `apps/worker/src/publish`, `apps/apple`, `apps/web` | **Tamam (denetlendi)** |
| Faz 4 | **Native iOS Uygulaması (%100 Saf UIKit)**: `StudioKit` tabanlı 4 sekmeli (`Sohbet`, `Postlar`, `Takvim`, `Ayarlar`) iOS uygulaması; Bonjour keşfi, 6 haneli kodla eşleştirme, Wecra sohbet/onay kartları, telefondan yuva doldurma, katman düzenleme ve hash onaylı zamanlama | `apps/apple/StudioIOS`, `apps/apple/StudioKit` | **Tamam (denetlendi)** (`StudioKit`: 61/61 test, `StudioIOS` derleme hatasız) |
| M1 | **Native macOS Uygulaması (%100 Saf AppKit)**: SwiftUI tamamen kaldırıldı; Liquid Glass (`NSGlassEffectView`), Sohbet, Başlangıç, Postlar, Katman Editörlü Post Detayı + Reels oynatıcı, Takvim (`⇧⌘K`), Medya Kütüphanesi & AI Görsel (`⇧⌘M`), Marka Profili ve Ayarlar | `apps/apple/StudioMac` | **Tamam (denetlendi)** (`StudioMac`: 28/28 test, `Studio.app` derlendi) |
| Faz 5 | **Reels Video Motoru**: 3 tarif (`motion_graphics`, Whisper/Gemini deşifreli `footage_edit`, ElevenLabs / macOS `say` seslendirmeli ve kelime senkron altyazılı `narration`) + Chromium kare yakalama + FFmpeg Reels normalizasyonu (`1080×1920`, H.264 `yuv420p`, 30 fps, AAC 48 kHz, `+faststart`) | `apps/worker/src/video` | **Tamam (denetlendi)** (gerçek Chromium + FFmpeg uçtan uca MP4 testi geçti) |
| Faz 6 | **LinkedIn & PDF Carousel**: `@studio/publishers` içinde LinkedIn REST yayıncısı (`text`, `image`, `multi_image`, `document` PDF carousel, `video`), `cloud-publisher` entegrasyonu ve tek geçişli çok sayfalı Chromium PDF dışa aktarımı | `packages/publishers/src/linkedin`, `apps/worker/src/render`, `apps/cloud-publisher` | **Tamam (denetlendi)** (`publishers`: 186/186 test) |
| F1-5 & F1-5b | **Web Editörü & Canlı Pano**: canlı iş akışı (`/api/jobs/stream`), iş iptali, Wecra sohbet arayüzü, korumalı `<iframe>` içinde sürükle-bırak/boyutlandır/geri al destekli görsel HTML katman editörü | `apps/web` | **Tamam (denetlendi)** (`web`: 85/85 test + Vite üretim paketi) |

## Yalnızca Burak'ın Hesap Girişiyle Yapılacak Canlı Bağlantı Adımları

Kod tarafındaki tüm motorlar ve arayüzler hazırdır; dış servislerle canlı yayın için:
1. **Hemen yerel kullanım (Mac + Gemini Chat & Üretim):** `.env` dosyanızdaki `GEMINI_API_KEY` sayesinde Claude limitiniz doluyken bile `open apps/apple/StudioMac/build/DerivedData/Build/Products/Debug/Studio.app` komutuyla uygulamayı açıp **Gemini Flash-Lite / Gemini Flash** ile hemen sohbet edebilir, plan çıkarabilir, AI görsel, post ve Reels üretebilirsiniz.
2. **Meta & LinkedIn canlı hesap bağlama:** Sağ paneldeki **Bağla** butonundan Meta erişim anahtarı (Sayfa + Instagram otomatik keşif) veya LinkedIn anahtarı girildiğinde şifreli kasaya kaydedilir.
3. **Bulut yayıncı / Tünel (isteğe bağlı, Mac kapalıyken yayın & dış ağ erişimi):** `apps/cloud-publisher/README.md` içindeki `wrangler login` + `wrangler deploy` adımları ve Ayarlar → Bu Mac altındaki Cloudflare Tunnel anahtarı.

## Ürünü tamamlama dalgaları (Burak, 2026-11-16 22:30: "olması gereken ne varsa yap, arayüzü nihai ürün yap; önce Mac, sonra iOS; onay bekleme")

Yukarıdaki "Tamam" satırlarının bir kısmı dış katkıyla (Gemini) yazıldı ve yönetici tarafından uçtan uca denenmedi. Bu dalgalarda her ajan önce kendi alanında gerçekte neyin çalıştığını yerel API'ye karşı teknik olarak denetler, sonra eksikleri tamamlar ve hataları düzeltir.

Kurallar: ajanlar en fazla Opus 5.5 / xhigh; aynı anda en fazla 3 ajan; para harcanmaz; dağıtım ve hesap değişikliği yapılmaz; yalnızca teknik test (ekran görüntüsü, pencere açan UI testi yok); her dalga yönetici tarafından doğrulanıp commit edilir.

| Dalga | No | İş | Efor | Durum |
|---|---|---|---|---|
| 1 | A5 | Sohbet ajanı (Wecra yöntemi) — ajan çalışmaya devam ediyor | xhigh | Çalışıyor |
| 1 | P1 | Mac postlar ve editör: postlar ızgarası, açık post, katman düzenleme, görsel yuvası doldurma, sürüm geçmişi ve geri al, "Neyi değiştireyim?", dışa aktarım (JPEG/PNG/PDF, paylaş) | xhigh | Çalışıyor |
| 1 | P2 | Mac ilk açılış ve marka: ilk açılış akışı (Claude girişi, Mac sunucusu, ilk marka), marka sihirbazı, marka kiti, örnek postlardan profil çıkarma, profil düzenleme ve onay | high | Çalışıyor |
| 2 | P3 | Mac yayın, hesaplar, takvim, bildirimler: hesap bağlama, zamanlama ve takvim, bulut yayıncı eşitleme, yayın günlüğü, macOS bildirimleri | high | Sırada |
| 2 | P4 | Mac nihai cila: menüler ve kısayollar, boş/yükleniyor/hata durumları, arama, medya, tutarlılık ve erişilebilirlik | high | Sırada |
| 3 | P5 | iOS: Mac ile eş düzey | xhigh | Sırada |
| 3 | P6 | Reels'in Mac arayüzünde uçtan uca kullanımı | high | Sırada |
