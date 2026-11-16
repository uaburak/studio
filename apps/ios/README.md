# Studio — iOS uygulaması

SwiftUI ile yazılmış "komuta + onay" uygulaması (PLAN.md §9). Telefondan brif gönderilir, iş canlı izlenir,
Mac'in render ettiği önizlemeler incelenir, açıklama düzeltilir, onaylanır ve zamanlanır. Tasarımın görsel
düzenlemesi Mac'teki editördedir; telefonda slayt HTML'i hiçbir zaman çizilmez, yalnızca Mac'in ürettiği görseller gösterilir.

- Swift 6 dil modu (tam katı eşzamanlılık denetimi), iOS 26.0 ve üstü, yalnızca iPhone, dikey.
- Üçüncü taraf bağımlılık yok.
- Arayüz Türkçe; açık/koyu görünüm, Dynamic Type ve VoiceOver etiketleri var.
- Paket kimliği yer tutucu: `net.burakkoc.studio`.

## Gereksinimler

- Xcode 27 (komut satırı araçları seçili: `xcode-select -p`)
- "iPhone 17" simülatörü (iOS 27 çalışma ortamı)
- Yerel API için depo kökündeki kurulum (kök `README.md`)

## Proje nasıl üretildi

`Studio.xcodeproj` elle tıklanarak değil, betikle üretilir ve depoya girer:

```sh
apps/ios/scripts/generate-project.sh
```

Betik sabit bir şablon yazar (sabit nesne kimlikleri; iki kez çalıştırmak aynı dosyayı verir). Proje Xcode 16+
"dosya sistemiyle eşzamanlı grup" kullanır: `Studio/`, `StudioTests/`, `StudioUITests/` altındaki her dosya kendi
hedefine otomatik girer, proje dosyası kaynak listesi tutmaz ve dosya ekleyince değişmez. Derleme ayarları
`Config/*.xcconfig` dosyalarındadır (proje dosyasında ayar yok):

| Dosya                      | İçerik                                                                 |
| -------------------------- | ---------------------------------------------------------------------- |
| `Config/Base.xcconfig`     | Ortak: iOS 26.0, Swift 6, katı eşzamanlılık, Debug/Release farkları    |
| `Config/App.xcconfig`      | Uygulama: paket kimliği, Info.plist anahtarları, simge                 |
| `Config/Tests.xcconfig`    | Birim testleri (uygulama içinde barındırılır)                          |
| `Config/UITests.xcconfig`  | Arayüz testleri                                                        |
| `Config/Studio-Info.plist` | Ayarla ifade edilemeyen anahtarlar: ATS yerel ağ izni, `tr` yerelleştirme |

Uygulama simgesi yer tutucudur: `swift scripts/make-icon.swift Studio/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png`.

## Derleme ve test

`apps/ios` klasöründe:

```sh
# Derle
xcodebuild -project Studio.xcodeproj -scheme Studio \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build/DerivedData build

# Tüm testler (birim + arayüz)
xcodebuild -project Studio.xcodeproj -scheme Studio \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -derivedDataPath build/DerivedData test

# Yalnızca birim testleri (hızlı)
xcodebuild ... test -only-testing:StudioTests
```

`build/` git'e girmez. Xcode'da açmak için: `open Studio.xcodeproj`, şema `Studio`, hedef iPhone 17.

### Testler

| Dosya                                 | Ne denetler                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `StudioTests/DecodingTests.swift`     | Çalışan API'den yakalanan gerçek yanıtların (`StudioTests/Fixtures`) çözülmesi, hata biçimi     |
| `StudioTests/OpenAPIDriftTests.swift` | Swift modellerinin alan adları/isteğe bağlılığı ve enum değerleri `/api/openapi.json` ile aynı mı |
| `StudioTests/ContentHashTests.swift`  | Telefonda hesaplanan sürüm hash'i sunucununkiyle bire bir aynı mı (`computeContentHash`)        |
| `StudioTests/APIClientTests.swift`    | URLProtocol taklidiyle istek kurma, kimlik başlıkları, hata eşleme, yükleme                     |
| `StudioTests/JobStreamTests.swift`    | WebSocket yeniden bağlanma: üstel bekleme, başarıdan sonra sıfırlama, iptal                     |
| `StudioTests/ScheduleTimeTests.swift` | Cihaz saat dilimi → UTC, yaz saati geçişleri, gün gruplama                                      |
| `StudioTests/ViewModelTests.swift`    | Gönderim, iş listesi, onay akışlarının durum makineleri; anahtar zinciri                        |
| `StudioUITests/LaunchTests.swift`     | Uygulamayı uygulama içi sahte sunucuyla açar: ana sayfa, brif gönderme, inceleme ve onay        |

Fixture'ları yenilemek (API çalışırken): `apps/ios/scripts/capture-fixtures.sh`. Betik geçici bir "iOS fixture"
markası oluşturur, her yanıtı kaydeder, iş akışı çerçevelerini (`capture-stream.mjs`, Node) yakalar ve markayı arşivler.
API sözleşmesi değişince bu betiği çalıştırın; `OpenAPIDriftTests` farkları gösterir.

## Simülatörde çalıştırma

```sh
# 1) Yerel API (depo kökünde; .dev.vars yoksa .dev.vars.example'dan oluşturun)
pnpm --filter @studio/api db:migrate
pnpm --filter @studio/api dev            # http://127.0.0.1:8787

# 2) Uygulama
cd apps/ios
xcrun simctl boot "iPhone 17"; open -a Simulator
xcodebuild -project Studio.xcodeproj -scheme Studio \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath build/DerivedData build
xcrun simctl install booted build/DerivedData/Build/Products/Debug-iphonesimulator/Studio.app
xcrun simctl launch booted net.burakkoc.studio
```

Hiç marka yoksa uygulama "Henüz marka yok" der; markalar web panosundan ya da
`curl -X POST localhost:8787/api/brands -H 'content-type: application/json' -d '{"name":"Deneme"}'` ile eklenir.

Sunucu olmadan denemek için sahte veriyle açın (yalnızca Debug derlemesi):
`xcrun simctl launch booted net.burakkoc.studio -StudioUITest`.

## Sunucu adresi ve kimlik

Ana sayfadaki dişli → **Ayarlar**:

- **Sunucu adresi.** Varsayılan `http://127.0.0.1:8787` (simülatör Mac'in loopback'ini paylaşır). Gerçek iPhone'da Mac'in
  yerel ağ adresi (`http://192.168.x.y:8787`; API'yi `--ip 0.0.0.0` ile başlatmak gerekir) ya da Cloudflare adresi (https).
  Düz http yalnızca yerel adreslerde çalışır (ATS `NSAllowsLocalNetworking`). "Bağlantıyı test et" `/api/health` çağırır.
- **Cloudflare Access servis token'ı.** Client ID + Client Secret; anahtar zincirinde, yalnızca bu cihazda
  (`AfterFirstUnlockThisDeviceOnly`) saklanır. Her HTTP isteğine ve WebSocket yükseltmesine
  `CF-Access-Client-Id` / `CF-Access-Client-Secret` başlığı olarak eklenir. Henüz gerçek token yok; yerel API istemez.
  Tek giriş noktası `RequestAuthorizing` (`Networking/ServerConfiguration.swift`); başka bir şema gerekirse yalnızca orası değişir.

## Mimari

```
Studio/
  App/          StudioApp + sekmeler, AppModel (marka, istemci), JobsStore (canlı iş listesi), push yeri
  Networking/   APIClient, uçlar, tek hata tipi (APIError), multipart yükleme, WebSocket + yeniden bağlanma
  Models/       Sözleşmenin Codable aynası, iş akışı çerçeveleri, içerik hash'i
  Storage/      Anahtar zinciri (servis token'ı), UserDefaults (adres, seçili marka)
  Features/     Home, Compose, Jobs, Review, Schedules, Settings
  Shared/       Durum görünümleri, rozetler, slayt önizleme/yakınlaştırma, biçimlendirme, zaman dilimi
  Debug/        Arayüz testleri için uygulama içi sahte sunucu (yalnızca Debug)
```

- **Ağ katmanı elle yazıldı**, `swift-openapi-generator` kullanılmadı: üretici bağımlılık ve derleme eklentisi getiriyor,
  WebSocket çerçevelerini kapsamıyor (OpenAPI belgesinde yoklar) ve ~15 modellik bir yüzey için fazla. Bunun yerine
  modeller gerçek yanıtlarla ve OpenAPI belgesiyle testte karşılaştırılıyor.
- **Hata:** her çağrı `APIError` fırlatır (Swift typed throws). API'nin `{ error: { code, message, issues } }` biçimi
  `.server(...)` olur; bağlantı yoksa `.offline`, Access reddi `.unauthorized`, HTML giriş sayfası `.unexpectedResponse`.
- **Canlı işler:** `GET /api/jobs/stream` WebSocket'i. Her bağlantıda gelen `jobs.snapshot` yerel durumu değiştirir.
  Kopunca 1, 2, 4 … 30 sn (±%20) bekleyip yeniden bağlanır; iki başarısız denemeden sonra 15 sn'de bir
  `GET /api/jobs` + `GET /api/workers/presence` yoklar. 25 sn'de bir `ping` gönderir, 50 sn sessiz kalan bağlantıyı
  kapatıp yeniden açar. Uygulama arka plana geçince bağlantı kapanır, öne gelince yeniden açılır.
- **Onay:** gösterilen sürümün slaytlarından hash telefonda yeniden hesaplanır (`Models/ContentHash.swift`, JavaScript
  `JSON.stringify` ile bayt bayt aynı). İçerik bu arada yeni sürüm aldıysa ya da hash tutmazsa onay gönderilmez.
- **Zamanlama:** tarih/saat cihaz saat diliminde seçilir, API'ye UTC (`…Z`) gider; ekranda saat dilimi ve gidecek UTC değeri görünür.
- **Ekler:** fotoğraflar JPEG'e çevrilir (Fotoğraflar HEIC veriyor, API kabul etmiyor), videolar MP4/MOV. Seçilince
  `POST /api/assets`'e ilerlemeyle yüklenir; yüklenen varlık kimlikleri `content.generate` işinin `payload.assetIds` alanına girer.

## Apple Developer Program üyeliği gelince

Şu an yalnızca simülatörde çalışır. Üyelikle yapılacaklar:

1. `Config/Base.xcconfig` → `DEVELOPMENT_TEAM`; paket kimliğini (`net.burakkoc.studio`) App ID olarak kaydetmek.
2. Gerçek cihaza kurulum (ücretsiz hesapla 7 günlük imza mümkün ama kalıcı kurulum ve TestFlight üyelik ister).
3. **Bildirimler:** Push Notifications yeteneği (`aps-environment` yetkisi), `UIApplicationDelegateAdaptor` ile cihaz
   token'ı, token'ı API'ye kaydeden bir uç (önerilen `POST /api/devices`, sözleşmede yok) ve gönderen taraf (API ya da
   Mac worker, PLAN.md §14 T6). Yer tutucu: `App/PushNotifications.swift`.
4. TestFlight / App Store Connect kaydı.

## Bilinen sınırlar

- Render hattı bitmediği için çoğu sürümde slayt görseli yok; uygulama bunu açıkça "Önizleme henüz yok" diye gösterir.
- Video (Reels) önizleme oynatıcısı yok; render edilmiş video varlıkları geldiğinde eklenecek.
- Görsel yuvasını telefondan doldurma ve metin katmanı düzeltme (PLAN.md §9) sözleşmede henüz uç olmadığı için yok.
- Marka ve sosyal hesap yönetimi web panosunda; uygulama yalnızca listeler.
