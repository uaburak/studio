# Studio — Görev Panosu

Son güncelleme: 2026-11-16. Mimari ve kararlar için: [PLAN.md](PLAN.md).

## Yönetim modeli

- **Yönetici:** Claude Fable 5.2 (ana oturum). Görevleri böler, ajanlara brifing yazar, çıktıyı denetler, parçaları birleştirir, Burak'ın kararlarını toplar.
- **Ajanlar:** en fazla Opus 5.5, en fazla "xhigh" efor. Efor göreve göre seçilir: mekanik iş `medium`, normal özellik `high`, mimariyi belirleyen iş `xhigh`.
- **Eşzamanlılık:** aynı anda en fazla 3 ajan (abonelik kullanım sınırını korumak için).
- **Sahiplik:** her ajanın kendi klasörü vardır; başka klasöre dokunmaz. Kapsam dışı gördüğü işi yapmaz, raporlar.
- **Doğrulama:** ajan raporu kanıt değildir. Bir görev, yönetici testleri kendisi çalıştırıp çıktıyı okuduktan sonra "tamam" olur.
- **Gizlilik:** ajanlar `.env` dosyasını okumaz; anahtarlar hiçbir çıktıya yazılmaz.
- **Git:** Burak isteyene kadar commit yapılmaz.

## Mimari düzeltmesi: önce Mac (Burak, 2026-11-16)

- Veriler ve üretim Mac'te. Sunucu yalnızca telefonun dışarıdan Mac'e ulaşması için köprü.
- Aynı ağda iPhone Mac'le doğrudan konuşur (Bonjour); sunucu gerekmez.
- Remote Control: Mac uygulamasında bir anahtar. Açıkken Cloudflare Tunnel ile social.burakkoc.net üzerinden erişim; sunucuda veri tutulmaz.
- Yalnız onaylanıp zamanlanan postlar (görsel, metin, zaman, paylaşım anahtarı) buluta gider; Mac kapalıyken de saatinde paylaşılır.

| No | Görev | Efor | Klasör | Durum |
|---|---|---|---|---|
| L1 | Mac'te yerel sunucu: Mac uygulaması API ve worker'ı kendisi başlatır ve yönetir; veriler uygulama klasöründe; Bonjour ile duyuru; cihaz eşleştirme ve cihaz anahtarları | high | `apps/api`, `apps/worker`, `apps/apple`, `packages/contract` | Çalışıyor |
| L2 | Bulut yayıncı: zamanlanmış postları alan ve saatinde paylaşan küçük Cloudflare Worker (yayıncılar paketiyle) | high | `apps/cloud-publisher` (yeni) | Çalışıyor |
| L3 | Remote Control: Mac uygulamasında anahtar, Cloudflare Tunnel, Access | medium | `apps/apple` | L1'den sonra; Burak'ın Cloudflare girişini bekliyor |

## Yön düzeltmesi (Burak, 2026-11-16)

- Ana ürün **native macOS uygulaması**; iOS sürümü onunla birlikte gelir. Web panosu ana arayüz değildir, en fazla iç araç olarak kalır.
- Ana yüzey bir **AI sohbeti**: "MTM için bu ayın postlarını üret, resimleri ben yükleyeceğim" denince ay planlanır, postlar görsel yuvalarıyla üretilir.
- Arayüz **Liquid Glass, minimal Apple tasarımı** olacak ve Burak'la adım adım yapılacak. Ajanlar kendi başına arayüz tasarlamaz.
- Sıra: **önce altyapının tamamı, sonra arayüz.**

### Altyapı sırası

| No | Görev | Efor | Klasör | Durum |
|---|---|---|---|---|
| A1 | Tasarım kiti (F1-2) | xhigh | `packages/design-kit` | Tamam (denetlendi) |
| A2 | Sohbet altyapısı: konuşma, mesaj, ajan turu ve plan kayıtları; API ve canlı akış | high | `apps/api`, `packages/contract` | Tamam (denetlendi) |
| A3 | Başsız Claude çağrısının abonelikle doğrulanması | | `spikes/design-render` | Tamam: 5/5 çağrı başarılı (görsel okuma dahil); Read aracı klasör dışına çıkabildiği için worker'da araç verilmeyecek |
| A4 | Worker üretim hattı: sohbet ajanı, aylık plan, post üretimi, kalite döngüsü, render, yükleme | xhigh | `apps/worker` | Tamam (denetlendi): uçtan uca 3 post üretildi |
| A5 | Marka profili: marka kiti yükleme, post çekme, analiz | high | `apps/api`, `apps/worker` | A4'ten sonra; post çekme Meta uygulamasını bekliyor |
| A6 | Yayın motoru: Meta girişi, token kasası, zamanlayıcı | xhigh | `apps/api` | Meta uygulamasını bekliyor |
| A7 | Ortak Swift paketi (macOS + iOS): API istemcisi, modeller, canlı akış | xhigh | `apps/apple/StudioKit` | Tamam (M1 içinde) |
| A2b | Görsel takma adları ve @anmalar (arka uç) | medium | `apps/api`, `packages/contract` | Tamam (denetlendi) |
| M2 | Model, efor ve kalan limit seçimi | high | `apps/api`, `packages/contract`, `apps/apple` | Tamam |
| M1 | Native macOS uygulaması: Wecra'da onaylanan altı ekran, açık ve koyu mod (Burak öne aldı) | xhigh | `apps/apple` | Tamam: derleme ve birim testleri geçiyor; görsel inceleme Burak'ta |
| A8 | Cloudflare'e dağıtım ve Access | high | `apps/api` | Burak'ın Cloudflare yetkilendirmesini bekliyor |

Durdurulan: F4-1 iOS ekranları (arayüz işi; yarım kalan kod `apps/ios` altında, commit edilmedi). Ağ katmanı A7'de yeniden ele alınacak.

## Faz 0 — Kurulum ve doğrulama

| No   | Görev                                                                                             | Kim              | Efor  | Klasör                                                   | Bitti ölçütü                                                                                     | Durum                   |
| ---- | ------------------------------------------------------------------------------------------------- | ---------------- | ----- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------- |
| F0-1 | Monorepo iskeleti ve araçlar                                                                      | Opus 5.5         | high  | kök, `apps/web`, `apps/api`, `apps/worker`, `packages/*` | Kurulum, tip denetimi, lint, test ve derleme hatasız; web sayfası API sağlık yanıtını gösteriyor | Tamam (denetlendi)      |
| F0-2 | Üretim denemesi (T1 + T2): abonelikle başsız Claude, tasarım sözleşmesi v0, render, örnek postlar | Opus 5.5         | xhigh | `spikes/design-render`                                   | En az 3 post (HTML + JPEG) kendi denetiminden geçiyor; bulgu raporu yazılı                       | Tasarım: tamam. Başsız çağrı: oturum bekliyor |
| F0-3 | Video motoru karşılaştırması (T3): HyperFrames ve Remotion                                        | Opus 5.5         | high  | `spikes/video-bakeoff`                                   | Aynı 8 saniyelik dikey video iki motorla üretilmiş, biçimi doğrulanmış; öneri raporu yazılı      | Tamam: HyperFrames      |
| F0-4 | Hub denemesi (T6): Durable Object WebSocket ile Mac worker gidiş-dönüşü                           | Opus 5.5         | high  | `spikes/cf-hub`                                          | Yerelde iş gönder, ilerleme al, sonuç al                                                         | Tamam (F0-1 içinde)     |
| F0-5 | Meta uygulaması ve test paylaşımı (T4)                                                            | Yönetici + Burak |       |                                                          | Kendi hesaba test paylaşımı herkese görünür                                                      | Burak'ı bekliyor        |
| F0-6 | Gemini görsel üretimi (T5)                                                                        | Yönetici         |       | `spikes/gemini-image`                                    | Üretim çalışıyor; maliyet krediden düşüyor                                                       | Kredi kontrolü kaldı    |
| F0-7 | Faz 0 kapısı                                                                                      | Burak + Yönetici |       |                                                          | Burak örnek postların kalitesini onaylar; video motoru seçilir                                   | F0-2 ve F0-3'ü bekliyor |

## Faz 1 — Çekirdek üretim (taslak; Faz 0 kapısından sonra kesinleşir)

| No   | Görev                                                                     | Efor  | Klasör                                      |
| ---- | ------------------------------------------------------------------------- | ----- | ------------------------------------------- |
| F1-1 | Veri modeli ve API: D1 şeması; marka, içerik, sürüm, iş uçları (TAMAM, denetlendi) | high  | `apps/api`, `packages/contract`             |
| F1-2 | Tasarım kiti: sözleşme, denetleyici, HTML yama araçları (ÇALIŞIYOR)       | xhigh | `packages/design-kit`                       |
| F1-3 | Worker üretim hattı: ajan çağrısı, kalite döngüsü, render, yükleme        | xhigh | `apps/worker`                               |
| F1-4 | Marka profili: post çekme, marka kiti yükleme, analiz, onay               | high  | `packages/brand`, `apps/api`, `apps/worker` |
| F1-5 | Web panosu: markalar, prompt, inceleme, dışa aktarım (TAMAM, denetlendi)   | high  | `apps/web`                                  |
| F1-6 | Hub ve iş kuyruğu (denemeden ürüne) (TAMAM, denetlendi)                   | high  | `apps/api`, `apps/worker`                   |

| F3-1 | Yayıncılar paketi: Instagram ve Facebook bağdaştırıcıları, sahte sunucuyla testler (TAMAM, denetlendi; gerçek Meta denemesi bekliyor) | high | `packages/publishers` |
| F4-1 | iOS uygulaması iskeleti ve ilk ekranlar (ÇALIŞIYOR; Faz 4'ten öne alındı) | high | `apps/ios` |
| F1-5b | Web: canlı iş akışı, iş iptali, Mac çevrimiçi göstergesi (SIRADA) | medium | `apps/web` |

Aynı klasöre dokunan görevler aynı anda yürütülmez.

## Sonraki fazlar (her kapıda görevlere bölünür)

| Faz | Kapsam                                                                                 | Beklenen efor            |
| --- | -------------------------------------------------------------------------------------- | ------------------------ |
| 2   | Editör, görsel yuvaları, prompt ile düzeltme, medya kütüphanesi, AI görsel sağlayıcısı | xhigh                    |
| 3   | Meta girişi, token kasası, yayıncılar, onay akışı, zamanlayıcı, takvim                 | high, yayın hattı xhigh  |
| 4   | iOS uygulaması (SwiftUI): komuta + onay                                                | high                     |
| 5   | Reels: video motoru, üç tarif, ses, altyazı, yayın                                     | high, kurgu tarifi xhigh |
| 6   | LinkedIn, performans geri beslemesi, müzik, Wecra, toplu planlama                      | high                     |

## Burak'tan beklenenler

| Ne                                                       | Hangi görev için      |
| -------------------------------------------------------- | --------------------- |
| Pilot marka onayı (şimdilik MTM Agro / Venta varsayıldı) | F0-2, F0-7            |
| Meta geliştirici hesabı ve işletme portföyü erişimi      | F0-5                  |
| Cloudflare bağlayıcısının yetkilendirilmesi              | Faz 1 dağıtımı        |
| Apple Developer Program üyeliği                          | Faz 4                 |
| Wecra'nın ne olduğu ve dışa aktarım imkânı               | F1-4                  |
| Claude planı (Pro / Max)                                 | Eşzamanlı ajan sayısı |
