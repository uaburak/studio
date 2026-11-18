# Studio masaüstü — yol haritası (2026-11-18)

Sahibin 13 maddelik geri bildirimine göre. Önce hızlı işler, en sona ağır işler.

Durum güncellemesi (2026-11-19): maddelerin hepsi yapıldı; kalan açıklar aşağıda "Açık" olarak
yazılı ve [DENETIM-PLANI.md](DENETIM-PLANI.md)'de izleniyor. "Yer" sütunu kodun nerede olduğunu
gösterir (`apps/desktop/src/renderer` altında, aksi yazılmadıkça).

## Faz 1 — Hızlı düzeltmeler

| #   | İş                                                                                                                               | Durum | Yer                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------ |
| 1   | Üst çubuktaki Sohbet / Postlar seçicisini kaldır                                                                                 | Tamam | `components/shell/`                                                |
| 2   | Geri / ileri her yerde çalışsın (gezinme geçmişi, ⌘[ ⌘], fare tuşları); Markalar önce marka listesini göstersin                  | Tamam | `lib/nav-gestures.ts`, `lib/menu-nav.ts`                           |
| 5   | Girişlerde odak çerçevesi yok (turuncu kenarlık kalkar)                                                                          | Tamam | `components/ui/`                                                   |
| 6   | Sol ve sağ panel kenarından genişlik ayarı (kalıcı)                                                                              | Tamam | `sidebarWidth` / `panelWidth` (`src/shared/ipc.ts`)                |
| 8   | Marka sayfası içeriği tam genişlik                                                                                               | Tamam | `features/brand/brand-page.tsx`                                    |
| 9   | Marka sekmeleri: Genel · Marka Kiti · Profil · Hesaplar · Ürünler (Ürünler yeni; gerekirse API + göç)                            | Tamam | `features/brand/products-tab.tsx`, göç `0012_brand_products`       |
| 4   | Fotoğraflar uygulaması gibi büyüyerek açılan / küçülerek kapanan görsel geçişi, aşağı sürükleyip kapatma; tek bileşen, her yerde | Tamam | `components/chat/lightbox.tsx`, `components/ui/zoomable-image.tsx` |

## Faz 2 — Orta işler

**7. Yapay zekâ sağlayıcıları (Ayarlar → Yapay zekâ)** — Tamam, kısmen

- Gemini API anahtarı alanı: anahtar Mac'teki kasaya (vault) yazılır, worker `.env` yerine oradan okur; "Denetle" düğmesi.
- Claude (mevcut), Gemini CLI, **Antigravity CLI** girişi, **Codex CLI** ("ChatGPT ile giriş"), **ChatGPT / OpenAI API anahtarı**.
- Worker'da her sağlayıcı için bir sürücü (claude -p gibi: `codex exec`, Gemini API/CLI, Antigravity CLI — kurulum ve giriş durumunu algılama), model listesi, varsayılan model; sohbet ve üretimde model menüsünde sağlayıcıya göre gruplama.
- Önce her CLI'nin başsız (headless) çalışma ve oturum durumunu sorgulama yolu doğrulanacak; doğrulanamayan sağlayıcı "yakında" olarak görünür.

Yer: `features/settings/sections/ai.tsx`, `apps/worker/src/providers/`, `apps/worker/src/gemini/`.
Açık: Antigravity yalnızca metin (Studio araçları yok), Codex ve OpenAI kısmi. Gemini CLI ve Codex
yalnızca Studio araçlarıyla çalışır (G3, G4); gerçek model turuyla yeniden denenmeli.

**11. Gemini harcaması ve kredi** — Tamam

- Her Gemini çağrısının `usageMetadata` token sayıları × fiyat tablosu ile harcama hesabı; iş başına kaydedilir, Ayarlar → Kullanım'da gün / ay toplamı ve model kırılımı.
- Kalan kredi: Gemini API'nin bakiye uç noktası yok; Google Cloud faturalandırma bağlanırsa oradan okunur, yoksa "bilinmiyor" + AI Studio bağlantısı. Kullanıcı aylık bütçe girerse kalan bütçe gösterilir.

Yer: `features/settings/sections/ai.tsx`, API `0013_ai_providers`, `0018_ai_preferences`. Claude
sınırı dolunca "Sor / Gemini'ye geç / Bekle" tercihi ve aylık bütçe (S7, U3). OpenAI ve ElevenLabs
harcaması da kaydediliyor (U8).

**10. Cihazdaki yazı tipleri** — Tamam

- Electron'da yüklü yazı tipleri listesi (Local Font Access / CoreText), marka fontları üstte; arama, önizleme.
- Render tarafı (Playwright/Chromium) aynı Mac'te çalıştığı için yüklü fontlar doğrudan kullanılabilir; post tasarım verisinde font ailesi + ağırlık saklanır, eksik fontta uyarı.

Yer: `apps/desktop/src/main/fonts.ts`, `lib/fonts.ts`. WOFF / WOFF2 marka fontları ve eksik fontta
kayıt / onay durdurma (E9) tamam.

## Faz 3 — Üretim hattı (plan + yapım)

**12. Markaya özel skill dosyaları** — Tamam

- Her markanın "Marka Kiti" altında bir veya birkaç **skill** (Markdown talimat; Wecra'daki `mtm`, `partner` skill'leri gibi: format ölçüleri, yerleşim pikselleri, ton, yasaklar).
- Ajan sohbet ve post üretiminde ilgili markanın skill'lerini bağlama ekler; skill sürümlenir, düzenleyici + "AI ile çıkar" (geçmiş postlardan skill taslağı).

Yer: `features/brand/skills-section.tsx`, iş türü `brand.skill_draft`, göç `0014_brand_skills`.

**13. Üretim kontrol adımları** — Tamam, kısmen
Her üretim (post / carousel / story / Reels) şu kapılardan geçer, sonuçlar post ayrıntısında "Kontroller" listesi olarak görünür:

1. Brief kontrolü — istek eksikse ajan soru kartıyla sorar.
2. Marka uyumu — renk, font, logo kullanımı skill + kit kurallarına göre.
3. Yerleşim — metin taşması, kenar boşlukları, platform güvenli alanları (story / Reels), okunabilirlik kontrastı.
4. Metin — yazım / dil bilgisi (Türkçe), açıklama ve hashtag platform sınırları, yasak kelimeler.
5. İçerik doğruluğu — ürün adı / iddialar Ürünler listesiyle karşılaştırılır.
6. Görsel kalite — çözünürlük, bozulma, logo okunurluğu.
7. İnsan onayı — onay (hash kontrolü) ve zamanlama.
   Otomatik düzeltilebilenler düzeltilir (yeni sürüm), diğerleri uyarı olarak kalır; kontroller marka bazında açılıp kapatılabilir.

Yer: `apps/worker/src/checks/`, iş türü `content.check`, göç `0015_generation_checks`; tuvalde
"Kontroller" sekmesi ve onay kapısı API'de (E5–E7). Açık: brief kontrolü yalnızca uzunluk ve
platform (soru kartı yok); görsel kalite ve marka uyumunda model yalnızca metne bakıyor.

## Faz 4 — Ağır iş

**3. Post düzenleyici = Wecra tasarım tuvali** — Tamam

- Önce tasarım: Wecra'daki Studio dosyasına "Post Editor" bölümü.
- Sonra yapım: Wecra'nın C++ motoru ve tasarım tuvali Studio'ya uyarlanır — tuval, yakınlaştırma/kaydırma, slaytlar = artboard, seçim tutamaçları, akıllı kılavuzlar, katmanlar, özellik paneli, cihaz fontları, marka kiti hızlı seçimleri; prototip / bileşen / dev mode yok.
- Post verisi (design-kit HTML/CSS sözleşmesi) ↔ tuval modeli dönüşümü; kaydetme yine sürüm olarak.

Yer: `features/post-editor/`, ayrıntı [apps/desktop/docs/editor.md](../apps/desktop/docs/editor.md).
Tuvalde açılan postta Wecra belgesi asıl kaynak (S1); yapay zekâ belgeyi Wecra araçlarıyla düzenler
(`canvas.read` / `canvas.apply`, gizli tuval çalıştırıcısı); taslak / sürüm ayrımı (S5); marka stilleri,
güvenli alan, yuva doldurma, logo ekleme tamam (Faz 3 E1–E19).
