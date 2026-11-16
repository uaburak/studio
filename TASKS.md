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

## Faz 0 — Kurulum ve doğrulama

| No   | Görev                                                                                             | Kim              | Efor  | Klasör                                                   | Bitti ölçütü                                                                                     | Durum                   |
| ---- | ------------------------------------------------------------------------------------------------- | ---------------- | ----- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------- |
| F0-1 | Monorepo iskeleti ve araçlar                                                                      | Opus 5.5         | high  | kök, `apps/web`, `apps/api`, `apps/worker`, `packages/*` | Kurulum, tip denetimi, lint, test ve derleme hatasız; web sayfası API sağlık yanıtını gösteriyor | Tamam (denetlendi)      |
| F0-2 | Üretim denemesi (T1 + T2): abonelikle başsız Claude, tasarım sözleşmesi v0, render, örnek postlar | Opus 5.5         | xhigh | `spikes/design-render`                                   | En az 3 post (HTML + JPEG) kendi denetiminden geçiyor; bulgu raporu yazılı                       | Çalışıyor               |
| F0-3 | Video motoru karşılaştırması (T3): HyperFrames ve Remotion                                        | Opus 5.5         | high  | `spikes/video-bakeoff`                                   | Aynı 8 saniyelik dikey video iki motorla üretilmiş, biçimi doğrulanmış; öneri raporu yazılı      | Tamam: HyperFrames      |
| F0-4 | Hub denemesi (T6): Durable Object WebSocket ile Mac worker gidiş-dönüşü                           | Opus 5.5         | high  | `spikes/cf-hub`                                          | Yerelde iş gönder, ilerleme al, sonuç al                                                         | Tamam (F0-1 içinde)     |
| F0-5 | Meta uygulaması ve test paylaşımı (T4)                                                            | Yönetici + Burak |       |                                                          | Kendi hesaba test paylaşımı herkese görünür                                                      | Burak'ı bekliyor        |
| F0-6 | Gemini görsel üretimi (T5)                                                                        | Yönetici         |       | `spikes/gemini-image`                                    | Üretim çalışıyor; maliyet krediden düşüyor                                                       | Kredi kontrolü kaldı    |
| F0-7 | Faz 0 kapısı                                                                                      | Burak + Yönetici |       |                                                          | Burak örnek postların kalitesini onaylar; video motoru seçilir                                   | F0-2 ve F0-3'ü bekliyor |

## Faz 1 — Çekirdek üretim (taslak; Faz 0 kapısından sonra kesinleşir)

| No   | Görev                                                                     | Efor  | Klasör                                      |
| ---- | ------------------------------------------------------------------------- | ----- | ------------------------------------------- |
| F1-1 | Veri modeli ve API: D1 şeması; marka, içerik, sürüm, iş uçları (TAMAM, denetlendi) | high  | `apps/api`, `packages/contract`             |
| F1-2 | Tasarım kiti: sözleşme, denetleyici, HTML yama araçları (denemeden ürüne) | xhigh | `packages/design-kit`                       |
| F1-3 | Worker üretim hattı: ajan çağrısı, kalite döngüsü, render, yükleme        | xhigh | `apps/worker`                               |
| F1-4 | Marka profili: post çekme, marka kiti yükleme, analiz, onay               | high  | `packages/brand`, `apps/api`, `apps/worker` |
| F1-5 | Web panosu: markalar, prompt, inceleme, dışa aktarım (ÇALIŞIYOR)          | high  | `apps/web`                                  |
| F1-6 | Hub ve iş kuyruğu (denemeden ürüne) (TAMAM, denetlendi)                   | high  | `apps/api`, `apps/worker`                   |

| F3-1 | Yayıncılar paketi: Instagram ve Facebook bağdaştırıcıları, sahte sunucuyla testler (ÇALIŞIYOR; Faz 3'ten öne alındı) | high | `packages/publishers` |

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
