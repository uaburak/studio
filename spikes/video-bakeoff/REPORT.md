# F0-3 Video motoru karşılaştırması: HyperFrames ve Remotion

Tarih: 2026-11-16. Makine: MacBook M3, macOS 27.0.1, Node 24. Ajan: Opus 5.5.
Yönetici denetimi: çıktı dosyaları, biçim doğrulaması ve kare örnekleri kontrol edildi.

## Karar: HyperFrames (0.9.56 sürümüne sabitlenerek)

1. **Statik postlarla aynı biçim.** Video tek bir HTML/CSS + GSAP dosyası. `@hyperframes/sdk` ile metin, renk, görsel ve animasyon süresi tarayıcı açmadan değiştirilebildi. `hyperframes check` Reels güvenli alanı, kontrast ve boş ilk kare gibi denetimleri veriyor.
2. **Daha hızlı ve tekrarlanabilir.** 8 saniyelik klip 7,2 saniyede render edildi; dört render bayt düzeyinde aynı çıktı. Remotion'ın en iyi ayarı 16 saniye, varsayılanı 25 saniye; birden çok sekmeyle çıktısı her seferinde farklı.
3. **Lisans.** HyperFrames Apache-2.0. Remotion yalnızca 3 kişiye kadar ücretsiz.

## Ölçümler

| Ölçüt | HyperFrames | Remotion |
|---|---|---|
| Sürüm | 0.9.56, gsap 3.15.1 | 4.0.544 |
| Kurulum | 11 sn, 124 MB | 23 sn, 236 MB |
| Bu Mac'te çalışması | İlk seferde | Varsayılan tarayıcısı macOS 27'de takılıyor; `chrome-for-testing` moduyla çalışıyor |
| Kaynak | 1 dosya, 146 satır | 3 dosya, 183 satır |
| Render (8 sn, 240 kare) | 7,2 sn | 15–17 sn (tek sekme), 25 sn (varsayılan) |
| Tekrarlanabilirlik | Bayt düzeyinde aynı | Yalnızca tek sekmede aynı |
| ffmpeg | Dahil değil; dışarıdan verilmeli | Dahil |
| Reels uygunluğu (normalleştirme sonrası) | 15/15 | 15/15 |
| Görsel kalite | Net; Türkçe harfler doğru | Aynı (SSIM 0,995) |
| Sürüm temposu | 1.0 öncesi; son 30 günde 122 sürüm | Olgun; son 30 günde 9 sürüm |
| Telemetri | Varsayılan açık; `HYPERFRAMES_NO_TELEMETRY=1` ile kapanıyor | Lisans anahtarı yoksa göndermiyor |

İki motorun ham çıktısı da Reels ölçütlerini tek başına karşılamıyor; `tools/normalize.sh` geçişi gerekli (klip başına yaklaşık 3 saniye).

## ffmpeg komutunda yapılan değişiklikler

- `-movflags +negative_cts_offsets`: yoksa video 2 kare gecikmeyle başlıyor.
- `-threads 1`: çok iş parçacıklı kodlama her seferinde farklı çıktı veriyor.
- `-map 0:v:0 -map 1:a:0`, `-keyint_min 60`, `-color_range tv`.

## Riskler

- **Sürüm temposu:** HyperFrames günde birkaç sürüm çıkarıyor. Sürüm sabitlenir, yükseltme bilinçli yapılır.
- **GSAP lisansı:** Webflow'un ücretsiz lisansı, kullanıcıların kodsuz animasyon kurduğu rakip ürünleri kısıtlıyor. Tek kullanıcılı araçta sorun görünmüyor; araç başkalarına açılırsa hukuki okuma gerekir.
- **iOS:** Oynatıcılar iOS Safari ya da WKWebView'de denenmedi. Planda iOS zaten render edilmiş MP4 gösteriyor.

## Doğrulanmayanlar

Gerçek bir Instagram yüklemesi; uzun ya da video ağırlıklı kompozisyonlar; başka makinede tekrarlanabilirlik; Remotion tarayıcısının neden takıldığı.

## Dosyalar

- `out/hyperframes-reels.mp4`, `out/remotion-reels.mp4`: normalleştirilmiş videolar
- `out/frames/*-contact.png`: sekizer karelik özetler
- `hyperframes/index.html`, `remotion/src/Venta.tsx`: iki kompozisyon
- `tools/normalize.sh`, `tools/verify_reels.py`: normalleştirme ve doğrulama
