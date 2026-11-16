# Studio — Sosyal Medya Üretim ve Yayın Aracı

Plan v0.2 · 2026-11-16 · Durum: Burak üretime geçilmesini istedi; Faz 0 yürütülüyor. Görev dağılımı ve durum: [TASKS.md](TASKS.md)

Bu belge araştırma bulgularını, verilen kararları ve üretim planını tek yerde toplar. "Doğrulanmadı" diye işaretlenen her madde Faz 0'daki bir testle kapatılır; o testler geçmeden üzerine bir şey inşa edilmez.

---

## 1. Ürün özeti

Tek kullanıcılı (Burak) bir içerik stüdyosu. Kendi hesapları ve yönettiği müşteri hesapları için Instagram, Facebook ve LinkedIn'e post, carousel, story ve Reels üretir; her markanın tasarım diline ve metin tonuna sadık kalır; üretilen her şey elle düzenlenebilir; onaylanan içerik zamanlanıp otomatik paylaşılır.

Üretim Mac'te, Claude Code aboneliğiyle çalışır. Arayüz ve zamanlayıcı Cloudflare'dedir (`social.burakkoc.net`). iPhone'daki native uygulama her yerden prompt gönderir, sonucu önizler, onaylar.

## 2. Kesinleşen kararlar

| Konu          | Karar                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kullanıcı     | Yalnızca Burak. Kendi hesapları + müşteri hesapları (müşteri Sayfalarında yönetici/Business yetkisi var)                                              |
| Görsel kaynak | Ağırlıklı tipografi + grafik tasarım. Bazı müşterilerde AI ürün görseli. Bazı postlarda "görsel yuvası": tasarım hazırlanır, son görseli Burak yükler |
| Reels         | Motion graphics, kendi çekimlerin kurgusu, seslendirmeli anlatım                                                                                      |
| Paylaşım      | Onay + zamanlama. Onaysız hiçbir şey yayınlanmaz                                                                                                      |
| LinkedIn      | Kişisel profil(ler). İlk sürümde üretim + export; otomatik paylaşım sonraki fazda                                                                     |
| Mimari        | Hibrit: kontrol düzlemi Cloudflare'de, üretim ve render Mac'te                                                                                        |
| Mobil         | Native iOS (SwiftUI). İlk kapsam: komuta + onay; görsel düzenleme Mac'teki editörde                                                                   |
| Seslendirme   | Üç kaynak: ElevenLabs, kendi ses kaydı, yerel model (sağlayıcı arayüzü arkasında)                                                                     |
| AI görsel     | Gemini API (T5 testiyle teyit edilecek). Antigravity CLI kullanılmıyor. Elle üretip yükleme her zaman açık                                            |
| Marka kaynağı | Yayınlanmış postlar, Figma, marka kiti dosyaları, Wecra; sistemi net olmayan hesaplarda uygulama önerir, Burak onaylar                                |

Henüz karar verilmeyenler 14. bölümde.

## 3. Plana yön veren araştırma bulguları

### 3.1 Claude aboneliğiyle üretim

- Abonelik girişi "Claude Code ve Agent SDK'nın olağan, bireysel kullanımı" için tanımlı. Kişisel bir uygulamanın `claude -p` ya da Agent SDK çağırması açıkça onaylanmış değil, ama en savunulabilir senaryo bu. Yasak olan, aboneliği başka kullanıcılara sunmak. ([legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance.md), [agent-sdk/overview](https://code.claude.com/docs/en/agent-sdk/overview.md))
- Aboneliği kendi sunucunda/konteynerde çalıştırmak dokümanlarda ele alınmıyor (doğrulanmadı). Hibrit kararının gerekçesi bu.
- `ANTHROPIC_API_KEY` ortamda tanımlıysa başsız çalışmalar aboneliğe değil API'ye fatura edilir. `--bare` abonelik girişini hiç okumaz. İkisi de kullanılmayacak. ([authentication](https://code.claude.com/docs/en/authentication.md), [headless](https://code.claude.com/docs/en/headless.md))
- Başsız modda JSON şema ile yapılandırılmış çıktı, oturum sürdürme, MCP ve skill yükleme var. Agent SDK akış girdisinde görsel bloklarını kabul ediyor.
- Remote Control yalnızca Claude uygulamalarından sürülebiliyor; özel bir uygulamadan tetiklenemiyor. Telefon → Mac akışı için kendi kuyruğumuzu kuruyoruz. ([remote-control](https://code.claude.com/docs/en/remote-control.md))
- Doğrulanmadı: Haziran 2026'dan beri programatik kullanımın ayrı bir kredi havuzundan düştüğüne dair ikincil kaynaklar var; resmi sayfalarda böyle bir ayrım görünmüyor. Faz 0'da gerçek bir üretim çalıştırılıp kullanım sayfasına bakılacak.

### 3.2 Meta (Instagram + Facebook)

- Sahibi ya da yöneticisi olduğun hesaplar için Standard Access yeterli; App Review ve Business Verification gerekmiyor. ([instagram-platform/overview](https://developers.facebook.com/docs/instagram-platform/overview), [access-levels](https://developers.facebook.com/docs/graph-api/overview/access-levels))
- Seçilen kurulum: Facebook Login. Tek giriş hem Sayfaları hem bağlı Instagram hesaplarını kapsıyor; yerel video yüklemeyi ve Audio API'yi açıyor. Uzun ömürlü kullanıcı token'ından alınan Sayfa token'ının süresi dolmuyor.
- Instagram: görseller yalnızca JPEG ve herkese açık bir URL'den alınıyor (doğrudan yükleme yok). Carousel 20 öğeye kadar. Reels 3 sn–15 dk, 300 MB. Story'de çıkartma/bağlantı yok. Yerel zamanlama yok; zamanlayıcıyı biz yazıyoruz. ([ig-user/media](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media))
- Günlük paylaşım sınırı dokümanda tutarsız (50 ve 100). Sabit yazılmayacak, çalışma anında `content_publishing_limit` ile okunacak.
- Kendi postlarını okuma (medya, açıklama, etkileşim, insights) mümkün; marka analizi için kullanılacak. Lisanslı müzikli videolarda `media_url` gelmeyebiliyor.
- Facebook Sayfası: foto, çoklu foto, video, Reels (API'de en fazla 90 sn), story destekli; yerel zamanlama var.
- Doğrulanmadı: geliştirme modundaki uygulamanın Sayfa postları yalnızca rol sahiplerine görünüyor. Uygulamayı inceleme olmadan "Live" yapmanın yeterli olduğu ikincil kaynağa dayanıyor. Faz 0'da gerçek bir test paylaşımıyla kontrol edilecek.
- Meta'nın içerik yayınlayan resmi bir MCP sunucusu yok; doğrudan Graph API kullanılacak. Güncel sürüm v27.0.

### 3.3 LinkedIn

- Kişisel profile paylaşım onaysız açılıyor (`w_member_social`): metin, görsel, çoklu görsel, PDF belge (carousel), video. ([share-on-linkedin](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin), [posts-api](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api))
- Token 60 gün; sıradan uygulamalara yenileme token'ı verilmiyor. İki ayda bir tek tıkla yeniden yetkilendirme gerekir.
- Geçmiş postları API ile okumak kapalı. Ton analizi için LinkedIn veri dışa aktarımı ("Shares") ya da yapıştırma/ekran görüntüsü kullanılacak.
- API koşullarında "API ile paylaşımı otomatikleştirme" yasağı var (§3.1(26)); LinkedIn bunun yorumunu yayınlamıyor. İnsan onayı adımı ve düşük hacim korunacak. ([api-terms-of-use](https://www.linkedin.com/legal/l/api-terms-of-use))

### 3.4 Tasarım gösterimi, editör, video

- HTML/CSS, dil modellerinin en iyi görünen sonucu verdiği biçim; bu alandaki güncel ürünler (Claude Design, Open Design, HyperFrames) aynı yolu seçmiş. Koordinat tabanlı JSON sahne grafiklerinde modeller uzamsal yerleşimde zayıf kalıyor. Birebir karşılaştırmalı bir ölçüm yok; kanıt dolaylı.
- Sonuç: statik ve video için tek kaynak HTML/CSS. Canvas kütüphanesi (Fabric, Konva, Polotno) kullanılmayacak.
- Video motoru adayları: HyperFrames (Apache-2.0; HTML + GSAP, statiklerle aynı gösterim; 1.0 öncesi, çok sık sürüm çıkıyor) ve Remotion (olgun; bireyler ve 3 kişiye kadar şirketler için ücretsiz). Seçim Faz 0'daki karşılaştırma testiyle yapılacak.
- Dışa aktarım: Mac'te Playwright/Chromium. Editör önizlemesi de Chromium olduğu için gördüğün ile çıkan aynı olur.

### 3.5 AI görsel üretimi

- Antigravity CLI (`agy`) başsız çalışıyor, ancak görsel üretimi için belgelenmiş bir arayüzü yok: oran, çözünürlük, referans görsel ve çıktı yolu için bayrak bulunmuyor. Kullanıcı raporlarına göre referans görseli yok sayıyor ve Kasım 2026'da birden çok kullanıcıda 500 hatası veriyor. ([issue 1202](https://github.com/google-antigravity/antigravity-cli/issues/1202), [issue 1312](https://github.com/google-antigravity/antigravity-cli/issues/1312))
- Google'ın SSS'si, `agy`'nin başka uygulamalara gömülmesini bireysel planlarda desteklemiyor; koşullar hesabın askıya alınmasına izin veriyor. ([faq](https://antigravity.google/docs/faq/), [terms](https://antigravity.google/terms))
- Gemini API aynı modelleri resmi yoldan sunuyor: referans görsel (10 nesne + 4 karakter), 4:5 ve 9:16 oran, 2K çözünürlük. Fiyat görsel başına 0,03–0,13 $. Ücretsiz katmanda görsel modeli yok. ([image-generation](https://aistudio.google.com/docs/image-generation), [pricing](https://aistudio.google.com/docs/pricing))
- Google Developer Program kredileri (AI Pro 10 $, AI Ultra 5x 40 $, AI Ultra 20x 100 $ / ay) Gemini API ve AI Studio kullanımına uygulanabiliyor. Her aylık kredi verildiği tarihten bir yıl sonra bitiyor; bir faturalama hesabına uygulanmış kredi başka hesaba taşınamıyor. Hariç tutulan kalemlerin listesi sayfada yok. ([benefits FAQ](https://developers.google.com/profile/help/benefits))
- Faturalama ön ödemeli ise önce en az 5 $ bakiye yüklenmesi gerekiyor. Uygun krediler bakiyeden önce harcanıyor; bakiye sıfıra inerse krediler de kullanılmıyor ve o hesaba bağlı tüm projelerde Gemini API duruyor (HTTP 402). Ön ödeme bakiyesi 12 ayda bitiyor ve iade edilmiyor. Sonradan ödemeli hesaplar için sıra belirtilmemiş. ([billing](https://aistudio.google.com/docs/billing))
- Google Cloud hoş geldin ve ücretsiz deneme kredileri Gemini API'de geçmiyor.
- İlk ücretli katmanda (Tier 1) aylık harcama tavanı 250 $, 10 dakikada 10 $. Üretilen tüm görsellerde görünmez SynthID filigranı var. ([rate-limits](https://aistudio.google.com/docs/rate-limits), [image-generation](https://aistudio.google.com/docs/image-generation))
- Kurulum: AI Studio → API keys → proje → Projects sayfasında "Set up billing" → mevcut faturalama hesabı → (ön ödemeliyse) en az 5 $ → anahtarı "Restrict to Gemini API only" ile kısıtla → Spend sayfasından aylık harcama sınırı. ([api-key](https://aistudio.google.com/docs/api-key))
- Burak'ın faturalama hesabında 2026-11-16 itibarıyla birikmiş Developer Program kredisi var (kabaca 200 $ karşılığı, bitişleri Ocak–Kasım 2027). API anahtarının projesi bu faturalama hesabına bağlı olmalı.
- Aynı hesaptaki "GenAI App Builder" deneme kredisi Gemini API çağrılarında geçmiyor; yalnızca Vertex AI Search içindir (forum kaynaklı; resmi koşullardan doğrulanmadı).
- Hesap durumu (2026-11-16, AI Studio'dan okundu): faturalama hesabı "Tier 1 · Prepay". Ön ödeme bakiyesi ₺250 (Burak yükledi; otomatik yükleme kapalı), servis açık. AI Studio ₺10,21K "eligible GCP credits" gösteriyor (GenAI App Builder kredisi bu tutara dahil değil). En düşük ön ödeme ₺250.
- Bu faturalama hesabına en fazla 5 proje bağlanabiliyor. Eski "Designer" projesinin faturalama bağlantısı kesildi (proje silinmedi), yerine yeni "Studio" projesi (`gen-lang-client-0853064149`) bağlandı. Çalışan projeler: DesignerV2, FinvoApp.
- Studio projesinde aylık harcama sınırı ₺2.000 (yaklaşık 40 $; sınır TL cinsinden tutuluyor).
- T5 ilk sonuç (2026-11-16): API anahtarı çalışıyor. `gemini-nano-banana-2.1` ile `generateContent` üzerinden referanssız 4:5 bir ürün görseli 13 saniyede üretildi (`spikes/gemini-image/generate.mjs`). 1K çıktı 928×1152, 2K çıktı 1856×2304 piksel geliyor. İstek AI Studio kullanım sayfasında göründü.
- T5 referanslı üretim (2026-11-16): Venta Borinc ürün fotoğrafıyla tarla sahnesi hem Nano Banana 2.1 hem Nano Banana Pro ile üretildi (2K, yaklaşık 26 saniye). Sahne, torba biçimi, logo ve ürün adı korunuyor; **etiketteki küçük yazılar iki modelde de bozuluyor** (başlıklar ve açıklama satırı yanlış harflerle yeniden çiziliyor). Bu haliyle ürün etiketi olan görseller yayınlanamaz. Çözüm adayı: sahneyi AI üretir, gerçek ürün görüntüsü sahneye bindirilir (etiket pikselleri aslından gelir). Henüz denenmedi.
- Burak'ın tercihi: AI görselleri 2K (1856×2304, 4:5) üretilir ve küçültülmez. Not: Instagram API en fazla 1440 piksel genişlik kabul ediyor; yayın anında bu sınıra göre küçültme gerekebilir.
- T5'te kalan: maliyetin karttan değil krediden düştüğünün faturalama raporunda görülmesi (maliyet verisi saatler sonra geliyor).

## 4. Mimari

```
 iPhone (SwiftUI)          Tarayıcı (Mac)
      │                        │
      └──────────┬─────────────┘
                 ▼
   ┌───────────────────────────────────────────┐
   │ Cloudflare · social.burakkoc.net          │
   │  Web arayüzü (editör + pano)              │
   │  API (Workers)                            │
   │  Hub (Durable Object, WebSocket)          │
   │  Veritabanı (D1) · Medya (R2)             │
   │  Zamanlayıcı + yayıncı                    │
   └───────────────┬───────────────────────────┘
        dışa giden │ WebSocket (tünel gerekmez)
                   ▼
   ┌───────────────────────────────────────────┐
   │ Mac worker (Node, açılışta otomatik)      │
   │  Üretim ajanı: Claude Agent SDK, abonelik │
   │  Render: Playwright/Chromium → JPEG/PDF   │
   │  Video: motor + ffmpeg                    │
   │  Ses: whisper, TTS sağlayıcıları          │
   │  Görsel: Gemini API                       │
   └───────────────────────────────────────────┘
                   │
                   ▼ (yayın, buluttan)
        Instagram · Facebook · LinkedIn
```

**Neden böyle:**

- Mac worker dışarıya bağlanır; Mac'e gelen bağlantı ya da tünel gerekmez.
- Mac kapalıyken telefondan girilen prompt sırada bekler, Mac açılınca işlenir. Uygulama Mac'in çevrimiçi olup olmadığını gösterir.
- Yayın bulutta çalışır. Onaylanıp zamanlanan içeriğin dosyası zaten R2'dedir (Instagram herkese açık URL istiyor), dolayısıyla Mac kapalıyken de paylaşım çıkar.
- Hesap token'ları yalnızca bulutta, şifreli durur; Mac'e inmez.

**Bileşenler (öneri; sürümler Faz 0'da sabitlenir):**

- Web: React + Vite + Tailwind, Cloudflare Workers üzerinde statik. Sunucu tarafı render gerekmiyor; uygulama giriş arkasında.
- API: Hono (Workers). Şemalar zod ile; OpenAPI tanımı buradan üretilir, iOS istemcisi ondan türetilir. Web, iOS ve worker aynı sözleşmeyi kullanır.
- Veri: D1 (markalar, hesaplar, marka profilleri, içerikler, sürümler, işler, takvim, yayın kayıtları). Medya: R2.
- Gerçek zaman: Durable Object WebSocket hub'ı (iş dağıtımı, canlı ilerleme).
- Yayın: çok adımlı, yeniden denemeli akış (konteyner oluştur → durum yokla → yayınla).
- Kimlik: Cloudflare Access (web için giriş; iOS ve worker için servis token'ı). Özel kimlik doğrulama kodu yazılmaz.
- Mac worker: `launchd` ile otomatik başlar; iş sürerken uykuyu engeller; işleri sırayla çalıştırır, kullanım sınırına takılınca bekler.

**Depo yapısı (monorepo, pnpm):**

```
apps/web        editör ve pano
apps/api        Workers API, hub, zamanlayıcı, yayıncı
apps/worker     Mac servisi: ajan, render, video, ses
apps/ios        SwiftUI uygulaması
packages/contract     ortak şemalar, OpenAPI, iş tipleri
packages/design-kit   tasarım sözleşmesi, denetleyici, katman modeli
packages/publishers   Meta ve LinkedIn bağdaştırıcıları
agent/          üretim ajanının çalışma alanı: skill'ler, marka klasörleri
```

## 5. Tasarım motoru

**Tasarım sözleşmesi.** Claude serbest HTML yazmaz; düzenlenebilirliği garanti eden bir sözleşmeye göre yazar:

- Slayt başına sabit piksel pano: 1080×1350 (4:5), 1080×1080, 1080×1920.
- Düzenlenebilir her öğe gerçek bir eleman ve kalıcı bir `data-layer` kimliği taşır; türü bellidir (metin, görsel, şekil, logo, yuva).
- Görseller `<img>` olur (arka plan CSS'i değil), böylece değiştirilebilir.
- Marka renkleri ve fontları CSS değişkenidir. Fontlar yerelde barındırılır.
- Statiklerde JavaScript yoktur.

**Kalite döngüsü.** Her üretimde: (1) Claude 2–3 varyant yazar, (2) otomatik denetim çalışır (taşma, üst üste binme, kontrast, güvenli alan, en küçük yazı boyutu), (3) ekran görüntüsü Claude'a geri verilir ve kendi çıktısını marka profiline göre eleştirip düzeltir, (4) sonuç sana gelir.

**Görsel yuvaları.** Tasarımda oranı ve maskesi belli bir yer tutucu bulunur; içerik "görsel bekliyor" durumunda kalır. Yuvayı Mac'ten ya da iPhone'dan yüklediğin fotoğraf, medya kütüphanesi ya da AI üretimi doldurur.

**Editör (web, Mac).** Korumalı bir çerçeve içinde doğrudan HTML üzerinde çalışır:

- Seç, taşı, boyutlandır, döndür; metni yerinde düzenle.
- Font, boyut, renk, hizalama; görsel değiştir ve kırp; katman sırası, gizle/göster.
- Geri al/yinele, sürüm geçmişi.
- "Prompt ile düzelt": öğe seçip talimat verirsin; Claude mevcut HTML'i yamalar, elle yaptığın değişiklikler korunur.

**Dışa aktarım.** Playwright ile PNG → Instagram için sRGB JPEG; LinkedIn carousel için PDF.

## 6. Marka profili

Her marka için üç parça tutulur:

- `brand.json`: renkler, fontlar, logo çeşitleri, boşluk, köşe yarıçapı, ızgara.
- `DESIGN.md`: yerleşim kalıpları, tipografik hiyerarşi, yapılacaklar/yapılmayacaklar, referans görseller.
- `VOICE.md`: ton, kelime dağarcığı, cümle uzunluğu, emoji ve hashtag alışkanlığı, çağrı kalıpları, dil, örnek metinler.

Ek olarak: onayladığın tasarımlardan oluşan şablon kütüphanesi ve en iyi performans gösteren postlardan referans seti.

**Kaynaklar:**

| Kaynak                      | Yöntem                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------- |
| Instagram/Facebook postları | API ile son N post, açıklama ve insights çekilir; Claude görselleri toplu analiz eder |
| Figma                       | Figma bağlantısıyla stiller, değişkenler ve şablon çerçeveler okunur                  |
| Marka kiti                  | Logo, font dosyası, renk kodu, kılavuz PDF'i yüklenir                                 |
| Wecra                       | Belirsiz; dışa aktarım ya da API imkânına göre (bkz. 14)                              |
| LinkedIn                    | Veri dışa aktarımı ya da yapıştırılan postlar                                         |
| Sistemi net olmayan hesap   | Claude postlardan bir sistem önerir                                                   |

Her profil sen onaylamadan kullanılmaz ve sürümlenir. Elle yaptığın düzeltmeler ve ret/onay kararların profile geri beslenir (örneğin bir markada başlıkları hep küçültüyorsan kural olarak önerilir).

Müşteri verisi ayrıdır: her markanın kendi çalışma klasörü vardır, üretim ajanı yalnızca o markanın bağlamını görür.

## 7. Video (Reels)

Üç tarif:

1. **Motion graphics.** Statik tasarım ya da carousel katmanları canlandırılır; aynı marka belirteçleri kullanılır.
2. **Çekim kurgusu.** Yüklediğin klipler yazıya dökülür (whisper, yerelde); Claude kesim yerlerini, başlık ve altyazı katmanlarını planlar; marka şablonuna oturtulur.
3. **Seslendirmeli anlatım.** Metin → ses (ElevenLabs, kendi kaydın ya da yerel model) → kelime düzeyinde zaman damgası → senkron altyazı ve görseller.

Her çıktı Instagram Reels kurallarına göre son bir ffmpeg geçişinden geçer (H.264, 4:2:0, 30 fps, AAC 48 kHz, moov başta).

İlk sürümde tam bir zaman çizelgesi editörü yok: metin, süre ve altyazı özellik panelinden ve prompt ile düzeltilir. Sahne kırpma ve sıralama sonraki fazda.

Müzik: Instagram için Audio API (Facebook Login ile kullanılabiliyor); diğer platformlarda lisansı uygun, videoya gömülü ses. Sonraki faz.

## 8. Yayın ve zamanlama

- Durumlar: taslak → incelemede → onaylandı → zamanlandı → yayınlanıyor → yayınlandı / hata.
- Onay belirli bir sürüme verilir. Onaydan sonra düzenlenen içerik yeniden onay ister.
- Tek zamanlayıcı tüm platformlar için kullanılır (Instagram'da yerel zamanlama olmadığı için).
- Instagram konteynerleri yayın anında oluşturulur (24 saatte süreleri doluyor).
- AI ile üretilmiş ürün görsellerinde Instagram'ın `is_ai_generated` işareti gönderilir.
- Token sağlığı izlenir: süre dolumu, 90 gün hareketsizlik kuralı; sorun olduğunda bildirim gelir.
- Yayıncı bir arayüzdür: Instagram, Facebook Sayfası, (sonra) LinkedIn. Yetki alınamayan bir müşteri hesabı çıkarsa aracı servis bağdaştırıcısı eklenebilir.

## 9. iOS uygulaması (SwiftUI) — komuta + onay

- Marka seçimi; prompt yazma (metin, dikte, fotoğraf/video ekleme).
- Canlı üretim ilerlemesi; Mac çevrimiçi durumu ve sıra.
- İnceleme: varyantlar arası kaydırma, yakınlaştırma, video oynatma. Önizlemeler Mac'in render ettiği gerçek çıktılardır.
- Hızlı metin düzeltme: metin katmanları form olarak gelir; değişiklik Mac'te yeniden render edilir.
- Görsel yuvasını telefondan doldurma.
- Açıklama düzenleme, onaylama, tarih/saat seçip zamanlama, takvim.
- Bildirimler: üretim hazır, paylaşıldı, hata, yeniden yetkilendirme gerekli.

Web arayüzü duyarlı olacağı için iOS uygulaması bitene kadar telefondan Safari ile de kullanılabilir.

Gereksinim: Apple Developer Program (yıllık 99 $) — bildirimler ve kalıcı kurulum için.

## 10. Güvenlik ve uyum

- Claude'un yazdığı HTML güvenilmeyen koddur: korumalı çerçeve, ağ erişimi kapalı.
- Üretim ajanında Bash ve web erişimi kapalıdır; yalnızca uygulamanın tanımladığı araçları kullanır.
- Hesap token'ları şifreli saklanır; anahtar Workers gizli değişkenindedir.
- Üçüncü taraf skill'ler depoya kopyalanır ve değişiklikleri diff olarak incelenir.
- Abonelik yalnızca Burak'ın kendi kullanımındadır. Araç başkasına açılırsa üretim API anahtarına taşınmalıdır; ajan katmanı bunu tek ayarla değiştirecek şekilde yazılır.
- Marka fontlarının lisansı render için barındırmaya izin vermelidir (marka bazında kontrol edilecek).

## 11. Skill'ler ve araçlar

Tümü 2026-11-16'da depo, yıldız ve son güncelleme üzerinden kontrol edildi. skills.sh kurulum sayıları şişirilebiliyor; yalnızca aşağıdaki doğrulanmış depolar kullanılacak.

**Geliştirme sırasında (Claude Code'a):**

| Skill                   | Kaynak                         | Neden                                           |
| ----------------------- | ------------------------------ | ----------------------------------------------- |
| frontend-design         | Anthropic                      | Arayüz ve tasarım kalitesi                      |
| agent-sdk-dev           | Anthropic                      | Agent SDK iskeleti ve doğrulayıcılar            |
| playwright-cli          | Microsoft                      | Render ve arayüz testleri                       |
| devtools                | Meta (resmi)                   | Uygulama kurulumu, izinler, token hata ayıklama |
| Video motoru skill'leri | remotion-dev ya da HyperFrames | Faz 0 testinin sonucuna göre                    |

Zaten kurulu: Cloudflare ve Figma eklentileri. Vercel eklentisi bu projede Cloudflare planıyla çelişen yönlendirmeler ekliyor; proje düzeyinde kapatılması önerilir.

**Çalışma anında (üretim ajanına, depoya kopyalanarak):**

| Skill                                                                     | Kaynak                                      | Kullanım                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| social, copywriting, copy-editing, marketing-psychology, content-strategy | coreyhaines31/marketingskills (MIT)         | Kanca, carousel yapısı, platform kuralları                           |
| humanizer                                                                 | blader/humanizer (MIT)                      | Yapay zekâ kokan kalıpları temizleme                                 |
| brand-voice (3 skill)                                                     | Anthropic knowledge-work-plugins            | Ton kılavuzu çıkarma ve denetleme; kurumsal bağlayıcılar çıkarılarak |
| canvas-design, theme-factory                                              | Anthropic                                   | Kompozisyon ve tema                                                  |
| ig-carousel, ig-reel, ig-caption                                          | Jakeschincariol/instagram-agent-skill (MIT) | Yalnızca başvuru metni; depo bakımsız                                |

**Kendi yazacağımız skill'ler (asıl değer burada):** tasarım sözleşmesi, marka profili çıkarma, carousel tasarımı, Reels tarifleri ve her marka için profilden üretilen marka skill'i. İlk yazılan: `.claude/skills/product-reference-image` (ürün fotoğrafından etiketi bozmadan görsel üretimi). Hazır skill'ler İngilizce ve SaaS ağırlıklı; Türkçe ton, markanın kendi postlarından ayarlanacak.

**Mac'e kurulacak araçlar:** pnpm, wrangler, ffmpeg, Playwright Chromium, whisper.cpp. (Kurulu: Node 24, git, gh, Claude Code.)

## 12. Fazlar

Her fazın bir çıkış ölçütü var; ölçüt sağlanmadan sonrakine geçilmez.

**Faz 0 — Kurulum ve doğrulama testleri (kısa).** Riskleri en başta kapatır.

- Depo, araçlar, skill'ler.
- T1: Abonelikle başsız üretim — yapılandırılmış çıktı, post görsellerini okuma, kullanımın nereden düştüğü.
- T2: Gerçek bir marka için tasarım sözleşmesiyle 3 post üretip render etme. **Senin gözünle kalite kararı: devam / yaklaşımı değiştir.**
- T3: HyperFrames ve Remotion ile aynı Reels'in üretilmesi; motor seçimi.
- T4: Meta uygulaması, giriş, müşteri Sayfasının listelenmesi, kendi hesabına test paylaşımı, herkese görünürlük.
- T5: Gemini API ile referans fotoğraflı ürün görseli; maliyetin karttan değil Developer Program kredisinden düştüğünün faturalama raporunda görülmesi.
- T6: Hub ↔ Mac worker gidiş-dönüşü, Access, Worker'dan iOS bildirimi.
- Çıkış: altı testin sonucu yazılı; plan buna göre güncellenmiş.

**Faz 1 — Çekirdek üretim (büyük).** Veri modeli, marka profili oluşturma (post çekme, marka kiti, Figma), post/carousel/story üretimi ve kalite döngüsü, web panosu, dışa aktarım.

- Çıkış: bir marka için prompt'tan dışa aktarılmış carousel.

**Faz 2 — Editör (büyük).** Doğrudan düzenleme, görsel yuvaları, prompt ile düzeltme, medya kütüphanesi, AI görsel sağlayıcısı.

- Çıkış: üretilen bir postta her öğeyi elle değiştirip yeniden dışa aktarabilmek.

**Faz 3 — Yayın ve takvim (orta).** Meta girişi ve token kasası, Instagram/Facebook yayıncıları, onay akışı, zamanlayıcı, takvim, hata yönetimi.

- Çıkış: zamanlanmış bir carousel Mac kapalıyken yayınlanıyor.

**Faz 4 — iOS uygulaması (orta).** Faz 1'deki API sözleşmesi hazır olunca diğer fazlarla paralel yürüyebilir.

- Çıkış: telefondan prompt → Mac'te üretim → telefonda onay → yayın.

**Faz 5 — Reels (büyük).** Video motoru, üç tarif, ses sağlayıcıları, altyazı, Reels yayını.

- Çıkış: üç tariften birer Reels üretilip yayınlanmış.

**Faz 6 — LinkedIn ve iyileştirme (orta).** LinkedIn yayını ve PDF carousel, performans verisinin profile geri beslenmesi, müzik, Wecra, toplu içerik planlama.

## 13. Maliyet

| Kalem                                | Tutar                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Claude                               | Mevcut abonelik                                                                                            |
| Cloudflare (Workers, D1, R2, Access) | Düşük hacimde 0–5 $/ay (doğrulanmadı; Faz 0'da netleşir)                                                   |
| Meta ve LinkedIn API                 | Ücretsiz                                                                                                   |
| Gemini API                           | Görsel başına 0,03–0,13 $; AI Ultra 5x ile gelen aylık 40 $ kredi karşılar (ön ödeme bakiyesi gerekebilir) |
| ElevenLabs                           | Kullanıma göre                                                                                             |
| Apple Developer Program              | 99 $/yıl                                                                                                   |
| Video motoru                         | Ücretsiz (her iki aday da bireysel kullanımda)                                                             |

## 14. Riskler ve açık konular

**Riskler**

| Risk                                                              | Önlem                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Abonelikle programatik kullanımın koşulu ya da kotası değişir     | T1; ajan katmanı API anahtarına tek ayarla geçebilir                   |
| Üretilen tasarım kalitesi beklentinin altında kalır               | T2 devam/dur kararı; marka profili, kalite döngüsü, şablon kütüphanesi |
| Geliştirme modundaki Meta uygulamasının postları herkese görünmez | T4                                                                     |
| HyperFrames henüz 1.0 değil                                       | T3; yedek Remotion                                                     |
| Mac kapalı ya da uykuda                                           | Sıra, durum göstergesi; yayın buluttan                                 |
| LinkedIn otomasyon maddesi                                        | İnsan onayı, düşük hacim                                               |
| iPhone önizlemesi Mac çıktısından farklı görünür                  | Telefonda yalnızca Mac'in render ettiği çıktı gösterilir               |
| Worker'dan iOS bildirimi gönderilemez                             | T6; yedek olarak Mac worker gönderir                                   |

**Senden gereken cevaplar**

1. Wecra nedir; dışa aktarım (SVG/PNG/JSON) ya da API'si var mı?
2. Apple Developer Program üyeliğin var mı?
3. İlk pilot marka hangisi? (T2 kalite testi onunla yapılacak.)
4. Claude planın hangisi (Pro / Max)? Üretim hızını ve sıra tasarımını etkiler.
5. Bu projede Vercel eklentisi kapatılsın mı?

**Faz 0 için senin hazırlayacakların**

| Ne                                                                                            | Hangi test | Durum    |
| --------------------------------------------------------------------------------------------- | ---------- | -------- |
| Gemini API anahtarı (Studio projesinde), faturalama bağlantısı, ₺250 ön ödeme, harcama sınırı | T5         | Tamam    |
| Gerçek bir ürün fotoğrafı                                                                     | T5         | Bekliyor |
| Pilot markanın hesabı ve varsa marka dosyaları                                                | T2         | Bekliyor |
| Meta geliştirici hesabı ve işletme portföyüne erişim                                          | T4         | Bekliyor |
| Cloudflare bağlayıcısının yetkilendirilmesi                                                   | T6         | Bekliyor |
| Apple Developer Program üyeliği                                                               | T6, Faz 4  | Bekliyor |

API anahtarları sohbete yapıştırılmaz; yerel `.env` dosyasına Burak koyar.

## 15. Araştırma kaynakları

- Claude Code: [headless](https://code.claude.com/docs/en/headless.md) · [authentication](https://code.claude.com/docs/en/authentication.md) · [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance.md) · [agent-sdk/skills](https://code.claude.com/docs/en/agent-sdk/skills.md) · [remote-control](https://code.claude.com/docs/en/remote-control.md)
- Meta: [content-publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing) · [ig-user/media](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media) · [app-modes](https://developers.facebook.com/docs/development/build-and-test/app-modes) · [reels-publishing](https://developers.facebook.com/docs/video-api/guides/reels-publishing) · [page-stories](https://developers.facebook.com/docs/page-stories-api) · [changelog](https://developers.facebook.com/docs/graph-api/changelog)
- LinkedIn: [posts-api](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) · [authorization-code-flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) · [versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning)
- Video: [HyperFrames](https://github.com/heygen-com/hyperframes) · [Remotion lisans](https://remotion.dev/docs/license/pricing)
- Görsel: [Gemini image generation](https://aistudio.google.com/docs/image-generation) · [gemini-api-cli](https://github.com/google-gemini/gemini-api-cli) · [Antigravity headless](https://antigravity.google/docs/cli/headless/)
- İncelenecek açık kaynak örnekler: [open-carrusel](https://github.com/Hainrixz/open-carrusel) · [open-design](https://github.com/nexu-io/open-design) · [postiz-app](https://github.com/gitroomhq/postiz-app)
