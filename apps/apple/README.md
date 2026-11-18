# Studio — Apple tarafı

iPhone uygulaması (`StudioIOS`, %100 UIKit) ve onun arayüzsüz çekirdeği (`StudioKit`, Swift paketi).
Swift 6 dil modu (tam katı eşzamanlılık), üçüncü taraf bağımlılık yok, arayüz Türkçe.

Mac uygulaması burada değil: Electron uygulaması `apps/desktop`. Eski AppKit uygulaması (`StudioMac`)
kaldırıldı; özellikleri Electron'a taşındı.

## Yapı

| Klasör | İçerik |
| --- | --- |
| `StudioKit/` | Swift paketi (iOS 26+; testler için macOS 26+). Arayüz yok. |
| `StudioKit/Sources/StudioKit/Models` | `packages/contract` aynası: marka, marka kiti, profil, sosyal hesap ve token sağlığı, varlık, içerik/sürüm, kontroller, zamanlama ve yayın kayıtları, işler, presence, sohbet, plan, akış çerçeveleri, yapay zekâ harcaması |
| `.../Networking` | `APIClient` (async/await, tek hata türü `StudioAPIError`), `AuthProvider` + cihaz anahtarı (`DeviceTokenAuth`, Anahtar Zinciri), çok parçalı ve arka planda yükleme |
| `.../Pairing` | Mac'i bulma (`StudioBrowser`, Bonjour `_studio._tcp`), QR ve kodla eşleştirme (`PairingClient`, `PairingInvite`), adres seçimi: önce yerel ağ, sonra tünel (`MacLink`) |
| `.../Streams` | `JobStream`, `ConversationStream` (`?after=seq` ile kaldığı yerden devam), yeniden bağlanma |
| `.../Domain` | İçerik hash'i (`computeContentHash` ile bit bit aynı), görsel yuvaları, katmanlar ve yamalar, post düzenleme oturumu, kontroller, takvim, Reels, `@anma`, Türkçe tarih biçimleri |
| `.../Services`, `.../Sample` | Servis protokolleri ve gerçek API uygulamaları; `SampleBackend` (önizleme ve test için bellekte örnek veri) |
| `StudioIOS/` | iPhone uygulaması (yalnızca iPhone, `TARGETED_DEVICE_FAMILY = 1`) |
| `scripts/` | `generate-ios-project.sh` (Xcode projesini üretir), `install-ios-device.sh` (bağlı iPhone'a kurar), `seed-local-api.sh` + `capture-fixtures.sh` (uygulamasız bir API'ye örnek veri ve StudioKit fixture'ları), `make-icon.swift` |

## Derleme ve test

Xcode projesi elle değil, sabit şablondan üretilir (dosya sistemiyle eşzamanlı gruplar; ayarlar
`StudioIOS/Config/*.xcconfig` içinde):

```sh
apps/apple/scripts/generate-ios-project.sh

swift test --package-path apps/apple/StudioKit
xcodebuild -project apps/apple/StudioIOS/StudioIOS.xcodeproj -scheme StudioIOS -configuration Debug \
  -destination 'generic/platform=iOS Simulator' build-for-testing
```

Simülatör derlemesi imza istemez. Kendi iPhone'una kurmak için:

1. `cp apps/apple/StudioIOS/Config/Local.xcconfig.example apps/apple/StudioIOS/Config/Local.xcconfig`
   ve içine Apple takım kimliğini (`DEVELOPMENT_TEAM`) yaz. Bu dosya git'e girmez; takım kimliği
   depoda hiçbir yerde tutulmaz.
2. Paket kimliği tek yerde: `Config/Base.xcconfig` → `STUDIO_BUNDLE_ID` (varsayılan
   `net.burakkoc.studio.ios`). Kendi takımın için değiştirmen gerekirse `Local.xcconfig`'te ez;
   Info.plist (`.pair`, `.refresh`) ve kod (arka plan görevi, yükleme oturumu, Anahtar Zinciri
   servisi) ondan türetir.
3. Xcode'da Run, ya da Xcode'da hesap oturumu yokken `apps/apple/scripts/install-ios-device.sh`
   (joker geliştirme profiliyle elle imzalar; varsayılan yalnızca kurar, açmaz).

## iPhone uygulaması

- **Kök ekran sohbet**: tam ekran sohbet, soldan çekmece (Postlar, Takvim, Markalar, Mac durumu, geçmiş
  sohbetler, Ayarlar). Marka / model menüsü, araç adımları, onay / soru / plan kartları, fotoğraf ve
  dosya ekleme, Türkçe dikte.
- **Postlar ve post ayrıntısı**: ızgara, hash doğrulamalı onay, kontroller listesi ve onay uyarısı,
  açıklama düzenleme, yuva doldurma, zamanlama, "Neyi değiştireyim?". Tuvalde düzenlenmiş postlar
  telefonda salt-okunur ("Mac'te düzenle").
- **Takvim**: aylık ızgara, zamanlanmış postlar, iptal.
- **Bildirimler**: biten işler, onay / soru bekleyen sohbetler, yayın sonuçları; arka planda yenileme
  önce yerel adresleri, sonra tünel adresini dener. Gerçek push yok (Apple Developer üyeliği bekliyor, S8).

## Mac'e bağlanma

Mac uygulaması yerel sunucuyu çalıştırır; telefon ona **yerel ağ geçidinden** (`:8791`) ya da evin
dışındaysa **Cloudflare Tunnel** adresinden bağlanır. Mimari: [docs/MIMARI.md](../../docs/MIMARI.md).

**Eşleştirme** (Mac: "iPhone'u bağla", sağ paneldeki iPhone bölmesinde ya da Ayarlar → Cihazlar'da):

1. Mac bir QR kodu ve 6 haneli kod gösterir. QR, Mac'in adını, kimliğini, yerel adreslerini, portunu,
   (açıksa) tünel adresini ve tek kullanımlık bir sır taşır (`studio://pair?...`).
2. Telefon QR'ı okutur ya da Bonjour ile Mac'i bulup kodu girer; `POST /api/pairing/claim` uzun bir
   cihaz anahtarı döner, telefon onu Anahtar Zinciri'ne yazar ve her istekte
   `Authorization: Bearer …` gönderir.
3. Mac eşleşmiş cihazları listeler; **Kaldır** anahtarı anında geçersiz kılar ve açık akışları kapatır.

**Uzaktan erişim**: Mac'te Ayarlar → Gelişmiş → Uzaktan erişim (tünel adresi ve anahtarı; varsayılan
adres yoktur). Telefonda Ayarlar → Gelişmiş → "Ek uzak adres" isteğe bağlıdır; QR'daki tünel adresi
yeterlidir.

Testler: `StudioKitTests` (çözümleme fixture'ları, istemci, akışlar, eşleştirme, QR, domain kuralları;
`Live*` testleri yalnızca ortam değişkeniyle özel bir API'ye karşı koşar), `StudioIOSTests` (model,
bağlantı, kabuk ve ekranların duman testleri; simülatörde).
