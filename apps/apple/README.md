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
- **Postlar & Post Detayı**: Gerçek yuva doldurma (`fillSlotAndRender`), boş yuvalarda **"AI ile Yuvayı Doldur…"**, **"Detaylar" | "Katmanlar"** sekmeleri (`SlideLayerScanner` ile metin/görünürlük katman düzenleme ve yeniden render), sürüm seçici (`v1`, `v2`…), çoklu slayt geçişi, Reels için `AVPlayerView` video oynatma, JPEG ve LinkedIn PDF Carousel dışa aktarma (`NSSavePanel`).
- **Takvim (`⇧⌘K`)**: Aylık 7 sütunlu ızgara (`Pzt..Paz`), durum noktaları (`Zamanlandı`, `Yayınlandı`, `Onaylandı`, `Hata`), seçili gün/ay listesi, yayın bağlantısı açma ve bekleyen zamanlamayı iptal etme.
- **Medya Kütüphanesi (`⇧⌘M`)**: Tür filtreleri (`Tümü`, `Görseller`, `Videolar`, `Belgeler (PDF)`), sürükle-bırak yükleme ve **"AI Görsel Üret"** sayfası (oran, 1K/2K çözünürlük, referans ürün fotoğrafı ve **"Ürün etiketini bozmadan koru"**).
- **Marka & Sosyal Hesaplar**: Yeni marka oluşturma (`+ Yeni Marka…`), `BrandProfileSheetController` (`DESIGN.md` / `VOICE.md` düzenleme, sürüm onaylama, AI marka analizi) ve `AccountConnectSheetController` (Meta sayfa/IG keşfi, doğrudan jeton kasası, LinkedIn OAuth bağlantısı, jeton sağlık kontrolü).
- **Yerel Sunucu & Uzaktan Erişim (Ayarlar → Bu Mac)**: gömülü API + Worker süreç gözetimi, 6 haneli telefon eşleştirme kodu üretimi ve `cloudflared` tünel yönetimi (`social.burakkoc.net`).

### `StudioIOS` (UIKit)
- **4 Sekmeli `UITabBarController`**: `Sohbet`, `Postlar`, `Takvim`, `Ayarlar`.
- **Sohbet**: Marka seçici, sohbet listesi, canlı ajan akışı, plan/soru/izin kartları, `PHPickerViewController` ile fotoğraf ekleme.
- **Postlar & Post Detayı**: Filtreli `UICollectionView` ızgarası, tam hash doğrulamalı onaylama, slayt geçişi, açıklama/etiket düzenleme, `UIDatePicker` ile zamanlama ve revizyon isteme.
- **Takvim**: Aylık ızgara + zamanlanmış post listesi, yayın bağlantısı ve iptal aksiyonu.
- **Ayarlar & Eşleştirme**: Mac'teki 6 haneli kod ile eşleştirme (`PairingSheetViewController`), Anahtar Zinciri Bearer jetonu, Uzaktan Kumanda (`https://social.burakkoc.net`) anahtarı ve görünüm seçimi.

## Kısayollar (`StudioMac`)

⌘N yeni sohbet · ⌘K ara · ⌃⌘S kenar çubuğu · ⌥⌘I sağ panel · ⌘[ / ⌘] geri / ileri · ⇧⌘P postlar · ⇧⌘K takvim · ⇧⌘M medya ·
⇧⌘L görünüm (Sistem → Açık → Koyu) · ⌘↩ açık postu onayla · composer'da ↩ gönder, ⇧↩ yeni satır, `@` takma ad öner.
