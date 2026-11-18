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
| `.../Shared` | Uygulama ile uzantıların ortak depolaması (`StudioSharedContainer`, `SharedDeviceTokenStore`), widget özeti ve önbelleği, `studio://open/...` bağlantıları, paylaşım kutusu (`ShareInbox`) |
| `.../Media` | Video yükleme kararı ve yeniden kodlama (`VideoUploadPlanner`, `VideoPreparation`), paylaşılan görselin hazırlanması (`ImagePreparation`) |
| `StudioIOS/` | iPhone uygulaması (yalnızca iPhone, `TARGETED_DEVICE_FAMILY = 1`) |
| `StudioIOS/StudioShare` | Paylaşım uzantısı "Studio'ya gönder" (UIKit, `$(STUDIO_BUNDLE_ID).share`) |
| `StudioIOS/StudioWidget` | Widget (WidgetKit; zorunlu olarak SwiftUI, `$(STUDIO_BUNDLE_ID).widget`) |
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

### Paylaşım uzantısı ve widget için kurulum

Proje üç hedef imzalar: uygulama (`STUDIO_BUNDLE_ID`), paylaşım uzantısı (`….share`) ve widget
(`….widget`). Uzantılar uygulamanın eşleştirmesini (cihaz anahtarı) ve bazı dosyalarını kullanır;
bunun için iki ortak alan vardır, ikisi de paket kimliğinden türer:

| Ortak alan | Kimlik | Ne için |
| --- | --- | --- |
| Paylaşılan Anahtar Zinciri grubu | `<takım>.$(STUDIO_BUNDLE_ID).shared` | Uzantılar cihaz anahtarını okur (Mac'e bağlanır). |
| App Group | `group.$(STUDIO_BUNDLE_ID)` | Paylaşım uzantısının büyük yüklemeleri sayfa kapanınca arka planda sürer ve uygulama bitirir; widget'ın son özeti uygulamayla ortak durur; son marka ve "Ek uzak adres" uzantılarca okunur. |

Hangilerinin imzaya gireceğini `Config/Local.xcconfig`'teki `STUDIO_SHARING` seçer
(varsayılan `YES`; yetki dosyaları `Config/Entitlements/`):

- **`YES`** (ücretli Apple Developer takımı): ikisi de. developer.apple.com → Identifiers'da
  App Group `group.<paket kimliği>` kayıtlı olmalı ve üç App ID'de (uygulama, `.share`, `.widget`)
  App Groups açık olmalı. Xcode'un otomatik imzası (Signing & Capabilities) bunları takım ücretliyse
  kendisi kaydeder; elle yapılacaksa önce App Group, sonra üç App ID. Anahtar Zinciri grubu ayrıca
  kayıt istemez.
- **`KEYCHAIN`** (ücretsiz kişisel takım; `install-ios-device.sh` de böyle imzalar, joker profil App
  Group taşıyamaz): yalnızca Anahtar Zinciri grubu. Paylaşım ve widget çalışır; ama paylaşım
  sayfası yükleme bitene kadar açık kalmalı ("Arka planda sürsün" çıkmaz), widget özetini kendi
  klasöründe tutar, uzantılar son markayı ve "Ek uzak adres"i bilmez (markaları Mac'ten okur).
  Ücretsiz kişisel takımlar App Groups yeteneğini desteklemeyebilir; Xcode "Personal development
  teams … do not support the App Groups capability" derse bunu seç.
- **`NO`**: ikisi de yok. Uygulama aynen çalışır; paylaşım sayfası ve widget "Studio'yu aç ve
  iPhone'u Mac'e bağla" der.

Yeni sürümün ilk açılışında cihaz anahtarı uygulamanın kendi Anahtar Zinciri öğesinden paylaşılan
öğeye, "Ek uzak adres" ve son marka App Group'a taşınır; yeniden eşleştirme gerekmez. Paylaşılan
grup bu kurulumda yoksa uygulama eski öğeyle devam eder. Durum: Ayarlar → Gelişmiş → "Paylaşım ve
widget". Uzantılar Bonjour kullanmaz: son çalışan adresi, Mac'in yerel ağ adreslerini, sonra tüneli
dener (yerel ağ izni uygulamanınkidir; evin dışında tünel gerekir).

## iPhone uygulaması

- **Kök ekran sohbet**: tam ekran sohbet, soldan çekmece (Postlar, Takvim, Medya, Ürünler, Markalar,
  Mac durumu, geçmiş sohbetler, Ayarlar). Marka / model menüsü, araç adımları, onay / soru / plan
  kartları, fotoğraf, video ve dosya ekleme (eklenen videodan sohbette Reels istenebilir), Türkçe dikte.
- **Medya** (N21): markanın fotoğraf ve videoları; Fotoğraflar, kamera ve Dosyalar'dan yükleme.
  Sunucu `video/mp4` ve `video/quicktime`'ı 50 MB'a kadar alır: sığan video olduğu gibi gider, sığmayan
  (ya da ProRes / başka kap) telefonda `AVAssetExportSession` ile HEVC / H.264 mp4'e küçültülür
  (ilerlemeyle), 540p'de bile sığmayan (≈2 dakikadan uzun) video kırpılmasını isteyen bir uyarıyla
  reddedilir. Videoya uzun basınca "Bu çekimden Reels yap": masaüstündeki sohbet aracının yaptığı gibi
  `reel` içeriği + `content.generate` (`reel.recipe = footage_edit`, `clipAssetId`).
- **Ürünler** (N23): liste, ayrıntı / düzenleme, silme. "Fotoğrafla hızlı ekle": fotoğraf yüklenir,
  form açılır; Mac fotoğrafı Apple Vision ile okuyunca (N12) etiketteki yazıdan ad, etiketlerden
  etiket, (açıksa) yapay zekâ açıklamasından kısa açıklama boş alanlara önerilir. Medya'da bir
  fotoğraftan "Ürün olarak ekle" de aynı formu açar.
- **Paylaşım uzantısı** (N20): Fotoğraflar, Dosyalar ve diğer uygulamalardan en çok 10 görsel ve 3
  video "Studio"ya gönderilir: marka, sonra hedef — Medya, bir sohbet (yeni ya da var olan, isteğe
  bağlı mesajla) ya da bir postun boş görsel yuvası (tek fotoğraf; Mac yeni sürümü render eder).
  App Group varsa yüklemeler arka plan oturumunda sürer; sayfa kapanırsa sistem uygulamayı uyandırır,
  uygulama mesajı gönderir / yuvayı doldurur ve bildirir.
- **Widget** (N22): küçük, orta, büyük ve kilit ekranı (yuvarlak, dikdörtgen, satır). Onay bekleyen
  post sayısı (tüm markalar), sıradaki yayınlar (saat, marka; orta / büyükte küçük resim), yayını
  başarısız olanlar. Dokununca ilgili ekran (`studio://open/...`). Mac'ten 20 dakikada bir (sıradaki
  yayın daha yakınsa ondan hemen sonra) okunur; Mac'e ulaşılamazsa son özet "Son: 14:05" notuyla
  gösterilir. Uygulama veri değişince ve arka plana geçince widget'ı yeniler.
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
ortak depolama ve taşıma, widget özeti, ürünler, video kararı, paylaşım teslimi: `PhoneFaz8Tests`;
`Live*` testleri yalnızca ortam değişkeniyle özel bir API'ye karşı koşar), `StudioIOSTests` (model,
bağlantı, kabuk ve ekranların duman testleri; simülatörde).
