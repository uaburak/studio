# Studio masaüstü — yol haritası (2026-11-18)

Burak'ın 13 maddelik geri bildirimine göre. Önce hızlı işler, en sona ağır işler.

## Faz 1 — Hızlı düzeltmeler (çalışıyor)
| # | İş | Durum |
|---|----|-------|
| 1 | Üst çubuktaki Sohbet / Postlar seçicisini kaldır | ajan |
| 2 | Geri / ileri her yerde çalışsın (gezinme geçmişi, ⌘[ ⌘], fare tuşları); Markalar önce marka listesini göstersin | ajan |
| 5 | Girişlerde odak çerçevesi yok (turuncu kenarlık kalkar) | ajan |
| 6 | Sol ve sağ panel kenarından genişlik ayarı (kalıcı) | ajan |
| 8 | Marka sayfası içeriği tam genişlik | ajan |
| 9 | Marka sekmeleri: Genel · Marka Kiti · Profil · Hesaplar · Ürünler (Ürünler yeni; gerekirse API + göç) | ajan |
| 4 | Fotoğraflar uygulaması gibi büyüyerek açılan / küçülerek kapanan görsel geçişi, aşağı sürükleyip kapatma; tek bileşen, her yerde | ajan |

## Faz 2 — Orta işler
**7. Yapay zekâ sağlayıcıları (Ayarlar → Yapay zekâ)**
- Gemini API anahtarı alanı: anahtar Mac'teki kasaya (vault) yazılır, worker `.env` yerine oradan okur; "Denetle" düğmesi.
- Claude (mevcut), Gemini CLI, **Antigravity CLI** girişi, **Codex CLI** ("ChatGPT ile giriş"), **ChatGPT / OpenAI API anahtarı**.
- Worker'da her sağlayıcı için bir sürücü (claude -p gibi: `codex exec`, Gemini API/CLI, Antigravity CLI — kurulum ve giriş durumunu algılama), model listesi, varsayılan model; sohbet ve üretimde model menüsünde sağlayıcıya göre gruplama.
- Önce her CLI'nin başsız (headless) çalışma ve oturum durumunu sorgulama yolu doğrulanacak; doğrulanamayan sağlayıcı "yakında" olarak görünür.

**11. Gemini harcaması ve kredi**
- Her Gemini çağrısının `usageMetadata` token sayıları × fiyat tablosu ile harcama hesabı; iş başına kaydedilir, Ayarlar → Kullanım'da gün / ay toplamı ve model kırılımı.
- Kalan kredi: Gemini API'nin bakiye uç noktası yok; Google Cloud faturalandırma bağlanırsa oradan okunur, yoksa "bilinmiyor" + AI Studio bağlantısı. Kullanıcı aylık bütçe girerse kalan bütçe gösterilir.

**10. Cihazdaki yazı tipleri**
- Electron'da yüklü yazı tipleri listesi (Local Font Access / CoreText), marka fontları üstte; arama, önizleme.
- Render tarafı (Playwright/Chromium) aynı Mac'te çalıştığı için yüklü fontlar doğrudan kullanılabilir; post tasarım verisinde font ailesi + ağırlık saklanır, eksik fontta uyarı.

## Faz 3 — Üretim hattı (plan + yapım)
**12. Markaya özel skill dosyaları**
- Her markanın "Marka Kiti" altında bir veya birkaç **skill** (Markdown talimat; Wecra'daki `mtm`, `partner` skill'leri gibi: format ölçüleri, yerleşim pikselleri, ton, yasaklar).
- Ajan sohbet ve post üretiminde ilgili markanın skill'lerini bağlama ekler; skill sürümlenir, düzenleyici + "AI ile çıkar" (geçmiş postlardan skill taslağı).

**13. Üretim kontrol adımları**
Her üretim (post / carousel / story / Reels) şu kapılardan geçer, sonuçlar post ayrıntısında "Kontroller" listesi olarak görünür:
1. Brief kontrolü — istek eksikse ajan soru kartıyla sorar.
2. Marka uyumu — renk, font, logo kullanımı skill + kit kurallarına göre.
3. Yerleşim — metin taşması, kenar boşlukları, platform güvenli alanları (story / Reels), okunabilirlik kontrastı.
4. Metin — yazım / dil bilgisi (Türkçe), açıklama ve hashtag platform sınırları, yasak kelimeler.
5. İçerik doğruluğu — ürün adı / iddialar Ürünler listesiyle karşılaştırılır.
6. Görsel kalite — çözünürlük, bozulma, logo okunurluğu.
7. İnsan onayı — onay (hash kontrolü) ve zamanlama.
Otomatik düzeltilebilenler düzeltilir (yeni sürüm), diğerleri uyarı olarak kalır; kontroller marka bazında açılıp kapatılabilir.

## Faz 4 — Ağır iş
**3. Post düzenleyici = Wecra tasarım tuvali**
- Önce tasarım: Wecra'daki Studio dosyasına "Post Editor" bölümü (ajan çiziyor).
- Sonra yapım: Wecra'nın C++ motoru (DesignerV2/engine) ve tasarım tuvali Studio'ya uyarlanır — tuval, yakınlaştırma/kaydırma, slaytlar = artboard, seçim tutamaçları, akıllı kılavuzlar, katmanlar, özellik paneli, cihaz fontları, marka kiti hızlı seçimleri; prototip / bileşen / dev mode yok.
- Post verisi (design-kit HTML/CSS sözleşmesi) ↔ tuval modeli dönüşümü; kaydetme yine sürüm olarak.
