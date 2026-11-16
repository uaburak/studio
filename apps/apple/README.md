# Studio — Apple uygulamaları

Native macOS uygulaması (`StudioMac`, %100 AppKit), native iOS uygulaması (`StudioIOS`, %100 UIKit) ve paylaşılan arayüzsüz çekirdek (`StudioKit`).
Swift 6 dil modu (tam katı eşzamanlılık), üçüncü taraf bağımlılık yok. Arayüz Türkçe.

## Yapı

| Klasör | İçerik |
| --- | --- |
| `StudioKit/` | Swift paketi (macOS 26+, iOS 26+). Arayüz yok; hem macOS hem iOS uygulaması doğrudan kullanır. |
| `StudioKit/Sources/StudioKit/Models` | `packages/contract` aynası: marka, marka profili, sosyal hesap & OAuth jeton sağlığı, varlık (`image`, `video`, `document`, `audio`), içerik/sürüm, zamanlama & yayın günlükleri, iş (`image.generate`, `schedule.publish` dahil), presence, sohbet, plan, akış çerçeveleri, `ConversationState` |
| `.../Networking` | `APIClient` (async/await, tek hata türü `StudioAPIError`, ayarlanabilir adres), `AuthProvider` (Cloudflare Access + cihaz eşleştirme Bearer jetonu, Anahtar Zinciri), çok parçalı yükleme + ilerleme |
| `.../Streams` | `JobStream` (yeniden bağlanma, üstel bekleme, HTTP yoklama yedeği), `ConversationStream` (`?after=seq` ile kaldığı yerden devam, boşlukta yeniden bağlanma) |
| `.../Domain` | İçerik hash'i (`computeContentHash` ile bit bit aynı), görsel yuvası tarayıcı (`Slots`), HTML katman tarayıcı ve yama üretici (`SlideLayers`), post panosu, takma ad ve `@anma` kuralları, Türkçe tarih biçimleri |
| `.../Services` | `ConversationService` ve `StudioDataService` protokolleri; gerçek API uygulamaları (`RemoteConversationService`, `RemoteStudioDataService`); mesajın tel biçimi tek yerde (`MessageWire`) |
| `.../Sample` | `SampleBackend`: bellekte, taslaklarla aynı Türkçe örnek veri (önizleme, test ve ekran görüntüsü için). |
| `StudioMac/` | macOS masaüstü uygulaması (%100 AppKit). Yerel API + Worker + Cloudflare Tunnel (`cloudflared`) gözetmeni içerir. |
| `StudioIOS/` | iPhone/iPad uzaktan kumanda uygulaması (%100 UIKit). Sohbet, Postlar, Takvim ve Ayarlar (kod ile eşleştirme + uzaktan tünel bağlantısı). |
| `scripts/` | `generate-project.sh` (macOS), `generate-ios-project.sh` (iOS), yerel API'ye örnek veri, fixture yakalama, ekran görüntüsü betikleri |

## Proje üretimi ve derleme

Xcode projeleri elle değil, sabit şablonlardan üretilir (Xcode 16+ dosya sistemiyle eşzamanlı gruplar; ayarlar `Config/*.xcconfig` içinde):

```sh
apps/apple/scripts/generate-project.sh
apps/apple/scripts/generate-ios-project.sh
```

```sh
# StudioKit
swift test --package-path apps/apple/StudioKit

# macOS uygulaması (StudioMac)
xcodebuild -project apps/apple/StudioMac/StudioMac.xcodeproj -scheme StudioMac -configuration Debug build
xcodebuild -project apps/apple/StudioMac/StudioMac.xcodeproj -scheme StudioMac -configuration Debug test

# iOS uygulaması (StudioIOS)
xcodebuild -project apps/apple/StudioIOS/StudioIOS.xcodeproj -scheme StudioIOS -configuration Debug -destination 'generic/platform=iOS Simulator' build-for-testing
```

## Ekranlar ve yetenekler

### `StudioMac` (AppKit)
- **Sohbet**: Canlı akış, araç adımları, yetki onay kartı (`consent`), soru kartı, plan kartı ("Onayla ve üret"), ekli görseller ve `@takma-ad` tamamlama.
- **Postlar**: ‹ › ile ay gezintisi, durum filtresi (Tümü / Hazır / Görsel bekliyor / Onaylandı / Zamanlandı / Yayınlandı), render edilmiş 4:5 kartlar, kartta "Render ediliyor" rozeti, klavye seçimi ve sağ tık menüsü (Aç, Hızlı bakış, Dışa aktar, Açıklamayı kopyala, Çoğalt, Sil…), yükleniyor / boş / hata durumları, hazır postlar için yüzen onay çubuğu.
- **Açık post ve editör**: karttan büyüyerek açılır; solda render edilmiş slayt ve renderer'ın ölçtüğü katman kutuları (tıkla seç, sürükle taşı, köşeden boyutlandır, çift tıkla metni düzenle, görseli yuvaya/görsel katmanına bırak), sağda **Post | Düzenle | Sürümler**. Her değişiklik design-kit yaması olarak `content.render` işine gider, yeni `manual_edit` sürümü render edilince görüntü değişir ("Render ediliyor"). Geri al/yinele sürümleri geri yükler. "Neyi değiştireyim?" bu sürümü AI ile düzeltir (`content.generate` + `baseVersion`). Açıklama ve etiketlerde platform karakter sayaçları; sürüm listesi ve "Bu sürümü geri yükle"; hash ile onay; zamanlama. Dışa aktarma: JPEG / PNG (bu slayt ya da tümü), PDF, Finder'da göster, paylaşma menüsü, açıklamayı kopyala; çoğaltma ve onaylı silme. Ortak mantık `StudioKit`'te (`DesignPatch`, `SlideCanvasGeometry`, `PostExporter`, `CaptionLimits`).
- **Takvim (`⇧⌘K`)**: Aylık 7 sütunlu ızgara (`Pzt..Paz`), durum noktaları (`Zamanlandı`, `Yayınlandı`, `Onaylandı`, `Hata`), seçili gün/ay listesi, yayın bağlantısı açma ve bekleyen zamanlamayı iptal etme.
- **Medya Kütüphanesi (`⇧⌘M`)**: Tür filtreleri (`Tümü`, `Görseller`, `Videolar`, `Belgeler (PDF)`), sürükle-bırak yükleme ve **"AI Görsel Üret"** sayfası (oran, 1K/2K çözünürlük, referans ürün fotoğrafı ve **"Ürün etiketini bozmadan koru"**).
- **İlk açılış (`Start/Onboarding*`)**: marka yoksa ya da Claude girişi yoksa açılır: Hoş geldin → Claude hesabı (`POST /api/workers/claude/login` ile `claude auth login --claudeai`, durum yoklanır) → Mac sunucusu (durum, worker, yerel ağ, telefon eşleştirme yönlendirmesi) → ilk marka (ad, kısa ad, dil, Instagram) → Hazır. Geçilebilir, kaldığı adımı hatırlar (`studio.onboarding.*`), tamamlanınca kendiliğinden açılmaz; Yardım → Başlangıç rehberi.
- **Marka ayarları (`Brands/`, ⇧⌘B; kenar çubuğunda marka başlığına sağ tık)**: Genel (ad, kısa ad, dil, onaylı arşivle / geri yükle) · Marka kiti (3–12 örnek post, açık/koyu zemin logoları, font + lisans notu, renk seçicili palet, notlar; kendiliğinden kaydedilir) ve **Profili çıkar** (`brand.analyze`, ilerleme ve hata görünür, yeniden açılınca çalışan iş izlenir) · Profil (sürüm geçmişi, token tablosu, DESIGN.md, VOICE.md, gerçekler/izinli sayılar, taslak kaydet, onayla, eski sürümü geçerli yap) · Hesaplar (platform başına hesap adı ve durumu; bağlama bu ekranda henüz yok). Yeni marka: ⇧⌘N. Kenar çubuğunda marka başlığına tıklamak markayı seçer (yeni sohbet, postlar, takvim, medya onu izler). Arşivlenmiş markalar Ayarlar → Markalar'da.
- **Sosyal hesap bağlama**: `AccountConnectSheetController` (Meta sayfa/IG keşfi, doğrudan jeton kasası, LinkedIn OAuth bağlantısı, jeton sağlık kontrolü) sağ paneldeki hesap satırından açılır.
- **Yerel Sunucu & Uzaktan Erişim (Ayarlar → Bu Mac)**: gömülü API + Worker süreç gözetimi, 6 haneli telefon eşleştirme kodu üretimi ve `cloudflared` tünel yönetimi (`social.burakkoc.net`).

### `StudioIOS` (UIKit)
- **4 Sekmeli `UITabBarController`**: `Sohbet`, `Postlar`, `Takvim`, `Ayarlar`.
- **Sohbet**: Marka seçici, sohbet listesi, canlı ajan akışı, plan/soru/izin kartları, `PHPickerViewController` ile fotoğraf ekleme.
- **Postlar & Post Detayı**: Filtreli `UICollectionView` ızgarası, tam hash doğrulamalı onaylama, slayt geçişi, açıklama/etiket düzenleme, `UIDatePicker` ile zamanlama ve revizyon isteme.
- **Takvim**: Aylık ızgara + zamanlanmış post listesi, yayın bağlantısı ve iptal aksiyonu.
- **Ayarlar & Eşleştirme**: Mac'teki 6 haneli kod ile eşleştirme (`PairingSheetViewController`), Anahtar Zinciri Bearer jetonu, Uzaktan Kumanda (`https://social.burakkoc.net`) anahtarı ve görünüm seçimi.

## Mac sunucusu: API ve worker'ı uygulama çalıştırır (L1)

Veriler ve üretim Mac'te. `StudioMac` açılınca (`studio.host.enabled`, varsayılan açık) `StudioMac/Host/LocalHost.swift`
şunları alt süreç olarak başlatır, gözetir ve kapanışta durdurur:

| Süreç | Komut | Adres |
| --- | --- | --- |
| migration (tek sefer) | `node wrangler.js d1 migrations apply DB --local --persist-to …` (120 sn zaman aşımı) | — |
| API | `node wrangler.js dev --ip 127.0.0.1 --port 8790 --persist-to …` (`apps/api`) | `127.0.0.1:8790` |
| yerel ağ geçidi | `node apps/api/scripts/lan-gateway.mjs` ("Yerel ağdan erişim" açıksa) | `0.0.0.0:8791` |
| worker | `node --import tsx src/main.ts` (`apps/worker`) | API'ye `ws://127.0.0.1:8790/api/hub` |

- **Durum klasörü:** `~/Library/Application Support/Studio/` → `api/state` (D1, R2, Durable Object), `worker/` (outbox,
  Claude durum dosyaları), `logs/{migrate,api,gateway,worker}.log` (5 MB'ta bir önceki kuşak `.1` olur), `instance-id`,
  `host.json` (son portlar). Repodaki `.wrangler/state` ile elle başlatılan geliştirme sunucusunun verisi ayrı kalır.
- **Gözetim:** her alt süreç kendi süreç grubunda (`posix_spawn`); çökünce 1, 2, 4 … 30 sn beklemeyle yeniden başlar,
  60 sn sağlıklı çalışınca sayaç sıfırlanır, art arda 8 hızlı çöküşte durur ("Yeniden başlat" ile tekrar). Lider süreç
  bitince grubunda kalan her şey (ör. `workerd`) öldürülür. Durdurma: SIGTERM, 8 sn sonra SIGKILL; önce worker (işleri geri
  verir), sonra geçit ve API. ⌘Q ve `kill <pid>` (SIGTERM) aynı yoldan kapatır.
- **İkinci kopya yok:** açılışta son port ve 8790 `/api/health` ile yoklanır; yanıt bu durum klasörünün `instance-id`'sini
  taşıyorsa (başka bir uygulama kopyası ya da çökmeden kalan süreçler) yeni süreç başlatılmaz, ona bağlanılır ("bağlandı").
  Port başka bir şeyde (ör. elle açılmış `wrangler dev`) ise boş bir port seçilir.
- **Araçlar:** Finder'dan açılan uygulamanın PATH'i kısadır; PATH bir kez giriş kabuğundan (`$SHELL -l -i -c`) okunur,
  `node` ve `claude` oradan bulunur. Depo yolu Ayarlar → Mac sunucusu → "Depo klasörü" (varsayılan: uygulamanın derlendiği
  depo, yoksa `~/Desktop/Burak/Code/Studio`); orada `pnpm install` yapılmış olmalı. **Node, wrangler ve worker'ın uygulama
  paketine gömülmesi sonraki adım.**
- **WORKER_TOKEN:** ilk açılışta rastgele üretilir, Anahtar Zinciri'nde (`net.burakkoc.studio` / `local-worker-token`)
  saklanır, iki alt sürece yalnızca ortam değişkeniyle verilir (wrangler'a `--env-file` ile boş bir dosya gösterilir ki
  `apps/api/.dev.vars` okunmasın). Depoya ya da diske yazılmaz.
- **Ayarlar → "Mac sunucusu":** durum (çalışıyor / başlatılıyor / hata + son günlük satırları), süreç durumları,
  "Yeniden başlat", "Yerel ağdan erişim", depo klasörü, kayıt klasörü. Anahtar kapatılırsa uygulama eskisi gibi "Sunucu"
  adresine bağlanır.
- **Bonjour:** geçit `_studio._tcp` olarak duyurulur (TXT: `name`, `api=1`, `pairing=required`). Info.plist:
  `NSLocalNetworkUsageDescription`, `NSBonjourServices`. macOS güvenlik duvarı açıksa `node` için gelen bağlantı izni
  sorulabilir.

### Telefon eşleştirme

1. Mac: Ayarlar → "Cihazlar" → **Telefon ekle**. 6 haneli kod çıkar (2 dakika, tek kullanımlık; yenisi eskisini geçersiz kılar).
2. Telefon: Bonjour ile Mac'i bulur (`StudioBrowser`), kodu ve cihaz adını `POST /api/pairing/claim`'e gönderir
   (`PairingClient`), dönen uzun cihaz anahtarını Anahtar Zinciri'ne yazar (`KeychainDeviceTokenStore`) ve sonraki her
   istekte `Authorization: Bearer …` gönderir (`DeviceTokenAuth`).
3. Mac: aynı bölümde eşleşmiş cihazlar listelenir; **Kaldır** anahtarı anında geçersiz kılar.

Mac uygulamasının kendisi eşleşmez: `127.0.0.1`'e konuşur ve "yerel" sayılır. Elle deneme:

```sh
CODE=$(curl -s -X POST 127.0.0.1:8790/api/pairing/codes | jq -r .code)
TOKEN=$(curl -s -X POST http://<mac-ip>:8791/api/pairing/claim -H 'content-type: application/json' \
  -d "{\"code\":\"$CODE\",\"deviceName\":\"Deneme\",\"platform\":\"ios\"}" | jq -r .token)
curl -s http://<mac-ip>:8791/api/brands                                  # 401
curl -s http://<mac-ip>:8791/api/brands -H "Authorization: Bearer $TOKEN"  # 200
```

Testler: `StudioKitTests/PairingTests` (URLProtocol taklidiyle eşleştirme istemcisi, hata eşleme, Anahtar Zinciri gidiş-dönüş,
TXT okuma), `StudioMacTests/HostSupervisorTests` (sahte süreç başlatıcıyla geri çekilme, sağlıklı çalışmada sıfırlama, pes
etme, durdurma; gerçek `posix_spawn` ile günlük yakalama ve SIGTERM'i yok sayan süreç grubunun öldürülmesi).

## Kısayollar (`StudioMac`)

⌘N yeni sohbet · ⇧⌘N yeni marka · ⇧⌘B marka ayarları (içinde ⌘1–⌘4 sekmeler) · ⌘K ara · ⌃⌘S kenar çubuğu · ⌥⌘I sağ panel · ⌘[ / ⌘] geri / ileri · ⇧⌘P postlar · ⇧⌘K takvim · ⇧⌘M medya ·
⇧⌘L görünüm (Sistem → Açık → Koyu) · ⌘↩ açık postu onayla · composer'da ↩ gönder, ⇧↩ yeni satır, `@` takma ad öner.

Postlar ve editör: oklar kart seçer, ↩ açar, boşluk Hızlı Bakış, ⌫ siler (onaylı), ⌘D çoğaltır, ⌘E dışa aktarır. Açık postta
esc seçimi kaldırır / kapatır, ← → slayt değiştirir ya da seçili katmanı 1 px (⇧ 10 px) kaydırır, ⇥ sonraki katman, ↩ metni
düzenler, ⌫ seçili katmanı gizler (seçim yoksa postu siler), ⌘Z / ⇧⌘Z geri al / yinele, ⌘W kapatır.
