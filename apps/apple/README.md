# Studio — Apple uygulamaları

Native macOS uygulaması (`StudioMac`) ve iOS ile paylaşılacak arayüzsüz çekirdek (`StudioKit`).
Swift 6 dil modu (tam katı eşzamanlılık), üçüncü taraf bağımlılık yok. Arayüz Türkçe.

## Yapı

| Klasör | İçerik |
| --- | --- |
| `StudioKit/` | Swift paketi (macOS 26+, iOS 26+). Arayüz yok; iOS uygulaması olduğu gibi kullanacak. |
| `StudioKit/Sources/StudioKit/Models` | `packages/contract` aynası: marka, hesap, varlık, içerik/sürüm, zamanlama, iş, presence, sohbet (mesaj parçaları), plan, akış çerçeveleri, `ConversationState` (sözleşmedeki reducer'ın birebir portu) |
| `.../Networking` | `APIClient` (async/await, tek hata türü `StudioAPIError`, ayarlanabilir adres), `AuthProvider` (Cloudflare Access servis anahtarı, Anahtar Zinciri), çok parçalı yükleme + ilerleme |
| `.../Streams` | `JobStream` (yeniden bağlanma, üstel bekleme, HTTP yoklama yedeği), `ConversationStream` (`?after=seq` ile kaldığı yerden devam, boşlukta yeniden bağlanma) |
| `.../Domain` | İçerik hash'i (`computeContentHash` ile bit bit aynı), görsel yuvası tarayıcı (HTML çalıştırmadan öznitelik okur), post panosu (durum, filtre, sayılar, onaylanabilir hash), takma ad ve `@anma` kuralları (sunucudaki `scanAliasTokens`/`resolveAliasMentions` portu, UTF-16 ofsetler), Türkçe tarih biçimleri |
| `.../Services` | `ConversationService` ve `StudioDataService` protokolleri; gerçek API uygulamaları (`RemoteConversationService`, `RemoteStudioDataService`); mesajın tel biçimi tek yerde (`MessageWire`) |
| `.../Sample` | `SampleBackend`: bellekte, taslaklarla aynı Türkçe örnek veri. Yalnızca önizleme, test ve ekran görüntüsü için. |
| `StudioMac/` | macOS uygulaması. `StudioMac.xcodeproj` betikle üretilir (aşağıda). |
| `scripts/` | proje üretimi, yerel API'ye örnek veri, fixture yakalama, ekran görüntüsü betikleri |

## Proje üretimi ve derleme

Xcode projesi elle değil, sabit şablondan üretilir (Xcode 16+ dosya sistemiyle eşzamanlı gruplar; dosya ekleyince proje
değişmez; ayarlar `StudioMac/Config/*.xcconfig` içinde; aynı girdi aynı çıktıyı verir):

```sh
apps/apple/scripts/generate-project.sh
```

```sh
# StudioKit
cd apps/apple/StudioKit
swift build
swift test

# macOS uygulaması
cd apps/apple/StudioMac
xcodebuild -project StudioMac.xcodeproj -scheme StudioMac -configuration Debug -derivedDataPath build/DerivedData build
xcodebuild -project StudioMac.xcodeproj -scheme StudioMac -configuration Debug -derivedDataPath build/DerivedData test
open build/DerivedData/Build/Products/Debug/Studio.app
```

Uygulama: `Studio.app`, paket kimliği yer tutucu `net.burakkoc.studio.mac`, hedef macOS 27.0, imza "yerelde çalıştır"
(geliştirici hesabı yok). Şimdilik sandbox kapalı (yerel geliştirme sunucusu); dağıtımdan önce açılmalı.

## Sunucuya bağlama

Varsayılan adres `http://127.0.0.1:8787` (`pnpm --filter @studio/api dev`). Değiştirmek için Ayarlar (⌘,) → Sunucu, ya da
tek açılış için: `Studio -studio.serverURL http://127.0.0.1:8790`. Cloudflare Access kurulunca servis anahtarı (Client ID /
Secret) Ayarlar'dan girilir, Anahtar Zinciri'nde saklanır ve her isteğe (WebSocket dahil) `CF-Access-Client-*` başlıkları
olarak eklenir.

Sunucu olmadan denemek için örnek veri: `Studio -StudioSampleData YES` (varsayılan değildir).

Yerel API'yi gerçekçi verilerle doldurmak (yalnızca 127.0.0.1/localhost kabul eder):

```sh
STUDIO_API_URL=http://127.0.0.1:8787 STUDIO_SEED_WORKER_TOKEN=<o API'nin WORKER_TOKEN'ı> apps/apple/scripts/seed-local-api.sh
```

Token verilirse betik sohbet ajanının yerine geçip asistan yanıtlarını, planı ve postları worker turn API'si ile yazar
(ajan henüz yok). Token yoksa yalnızca kullanıcı mesajları oluşur ve çalıştırmalar sırada kalır.

## Canlı olan / örnek olan

| Ekran parçası | Kaynak |
| --- | --- |
| Kenar çubuğu: markalar, sohbetler | Gerçek API (`/api/brands`, `/api/conversations`) |
| Sohbet: mesajlar, plan kartı, soru kartı, ilerleme, hata | Gerçek API + canlı sohbet akışı (`/api/conversations/{id}/stream`) |
| Mesaj gönderme, ekli görseller, takma adlar, `@anma` | Gerçek API (`attachments[{assetId, alias}]`, `mentions`, `/aliases`, yeniden adlandırma) |
| "Onayla ve üret" | `POST /api/plans/{id}/accept` (görülen revizyonla) + `/generate` |
| Postlar: kartlar, filtre, onay çubuğu | Gerçek API (`/api/contents`, sürümler, planlar, zamanlamalar); onay, uygulamanın yeniden hesapladığı hash ile |
| Açılan post: açıklama/etiket düzenleme, Onayla, Zamanla | Gerçek API (`PATCH` içerik, `approve`, `/api/schedules`) |
| "Neyi değiştireyim?" | `content.generate` işi (talimat + `baseVersion`); Mac'teki üretici olmadığı için sırada bekler |
| Sağ panel: marka, hesaplar, işler, "Mac hazır / çevrimdışı" | Gerçek API + iş akışı (`/api/jobs/stream`, kopunca HTTP yoklama) |
| Görsel yuvasına sürükle-bırak | Varlık olarak yüklenir; yuva doldurma hattı olmadığı için "Görsel yüklendi" bekleme durumu gösterilir |

Bilerek kapalı/etiketli olanlar: **Takvim** ("yakında", tasarımı onaylanmadı), hesap **Bağla** (Meta bağlantısı Faz 3;
tıklanınca açıklama çıkar), zamanlama kaydedilir ama yayın motoru yok (popover'da yazıyor). Sohbet ajanı (`chat.turn`)
henüz yok: gönderilen mesajın çalıştırması sırada kalır ve sohbette "Mac sırada bekliyor" yazar.

## Kısayollar

⌘N yeni sohbet · ⌘K ara · ⌃⌘S kenar çubuğu · ⌥⌘I sağ panel · ⌘[ / ⌘] geri / ileri · ⇧⌘P postlar ·
⇧⌘L görünüm (Sistem → Açık → Koyu) · ⌘↩ açık postu onayla · composer'da ↩ gönder, ⇧↩ yeni satır, `@` takma ad öner.

## Görünüm

Varsayılan sistem ayarını izler. Ayarlar → Görünüm, kullanıcı satırı menüsü ve Görünüm menüsü (Sistem / Açık / Koyu);
seçim saklanır, yeniden başlatmadan uygulanır. Renkler `Design/Theme.swift` içinde açık/koyu çiftleri olarak tanımlı.

## Testler

- `StudioKit` (Swift Testing): çalışan yerel API'den yakalanan yanıtların çözülmesi (`Tests/StudioKitTests/Fixtures`,
  yenilemek için `scripts/capture-fixtures.sh`), URLProtocol taklidiyle istemci, hata eşleme, çok parçalı yükleme,
  yeniden bağlanma/geri çekilme/yoklama yedeği/seq ile devam, reducer, takma ad ve anma kuralları, hash, örnek arka uç.
  `STUDIO_LIVE_API_URL=http://127.0.0.1:8787 swift test` ile çalışan yerel API'ye karşı uçtan uca testler de koşar
  (veri değiştirir; yalnızca yerel adres kabul edilir).
- `StudioMacTests`: uygulama modelleri (gezinme, composer takma adları ve yükleme kapısı, yeni sohbet, onay, açıklama),
  AppKit composer (anma jetonu, öneri, Return). Ekran görüntüsü testi pencere açtığı için varsayılan olarak kapalı
  (`STUDIO_RENDER_SCREENSHOTS=1`).

## iOS uygulaması neyi kullanacak

`StudioKit`'in tamamı: modeller, `APIClient`, akışlar, `ConversationService`/`StudioDataService`, post panosu, takma ad/anma
kuralları, hash doğrulama, `SampleBackend` (önizlemeler). macOS'a özgü olan yalnızca `StudioMac/` içindeki görünümler,
AppKit composer metin görünümü ve görsel içe aktarma.
