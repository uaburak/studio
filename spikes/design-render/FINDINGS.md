# F0-2 Üretim denemesi (T1 + T2): bulgular

Tarih: 2026-11-16. Ajan: Opus 5.5 (xhigh). Yönetici denetimi: örnek çıktılar görüldü; betikler yönetici tarafından yeniden çalıştırılmadı.

## Karar

- **Tasarım yaklaşımı: devam.** Claude tasarımı kısıtlı HTML/CSS olarak yazıyor, yerel Chromium 0,15–0,4 saniyede render ediyor, her öğe katman olarak düzenlenebiliyor. Dört örnek (altı pano) kendi denetiminden geçiyor.
- **Abonelikle başsız çağrı: doğrulanmadı.** Bu Mac'teki bağımsız `claude` komut satırının oturumu düşmüş (`claude auth status` → `loggedIn: false`). Hiçbir başsız model çağrısı başarılı olmadı. Tasarımları, başsız çağrının alacağı istek dosyasını okuyan taze bağlamlı Opus 5.5 alt ajanları üretti.

## Kapatılması gereken açık

Düz bir terminalde:

1. `claude auth login`
2. `cd spikes/design-render && npm run t1`
3. `node scripts/generate.mjs <brif> --transport cli --tag cli`

Bu üçü yapılmadan yapılandırılmış çıktı, görsel girdi, gerçek kullanım/maliyet değerleri ve post başına süre ölçülmüş sayılmaz.

## Worker için başsız çağrı tarifi

- Worker'a kendi oturumu: `CLAUDE_CONFIG_DIR=<worker klasörü> claude auth login` ya da `claude setup-token` ile `CLAUDE_CODE_OAUTH_TOKEN`.
- Çocuk süreç ortamı izin listesiyle kurulur; `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` geçirilmez; `--bare` kullanılmaz.
- Bayraklar: `-p --input-format stream-json --output-format stream-json --verbose --system-prompt-file F --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands --no-session-persistence --permission-mode dontAsk --permission-prompts none --json-schema S --model opus`
- Görseller stdin mesajında base64 blok olarak gider. Sonuç son `type:"result"` satırından okunur.
- Açılışta `claude auth status` ve küçük bir öz sınama çalıştırılır; oturum düşmüşse arayüzde gösterilir.
- `--setting-sources ""` ve `--strict-mcp-config` olmadan çağrı kullanıcının eklenti kancalarını ve MCP sunucularını içeri alıyor.

## Kalite değerlendirmesi

Güçlü: tek marka gibi okunuyor; Türkçe tipografi doğru; uydurma rakam ya da iddia yok; en iyi parça carousel.

Zayıf: dört post aynı iskeleti kullanıyor (şablon hissi); boş alanlar eleştiri geçişinde bazen yalnızca yer değiştiriyor; tipografi güvenli ama cesur değil; ürün postu katalog sayfası gibi; dizgiyle yapılmış geçici logo her başlıkla yarışıyor.

Düzey: sağlam kurum içi şablon. Tavanı marka profili belirliyor; gerçek postlar ve onaylı şablon kütüphanesi asıl kaldıraç.

## Üretim hattı için öneriler

1. Marka CSS'i yalnızca belirteç değil, denenmiş bileşenler de versin (rozet, imza, bant). Model rozeti dört ilk denemenin ikisinde hatalı kurdu.
2. Eleştiri geçişi hem denetim sonucunu hem ekran görüntüsünü alsın; gizlenmiş yazı hatasını yalnızca görsel eleştiri yakaladı.
3. Farklı yerleşim tiplerinde 2–3 varyant üretilsin.
4. 5 saatlik kullanım sınırı dolunca iş başarısız olmasın, sıfırlanma saatine kadar beklesin. Deneme sırasında bu sınıra takılındı.
5. Komut satırı sürümü sabitlensin; `--bare` ileride `-p` için varsayılan olabilir.

## Ölçümler

- Render + denetim: pano başına 150–520 ms. JPEG: 64–159 KB.
- İstek boyutu: üretim yaklaşık 36 KB; düzeltme 43–63 KB + 1–3 görsel.
- Gerçek bir post için tahmin (üretim + düzeltme): 40–80 bin token, 5–15 dakika. Ölçülmedi.

## Dosyalar

- `out/*/compare.jpg`: ilk deneme ve düzeltilmiş sürüm yan yana
- `out/04-image-slot/v2-filled/`: doldurulmuş görsel yuvası
- `CONTRACT.md`: tasarım sözleşmesi v0
- `brand/venta/`: geçici marka profili (sahibi onaylamadı; yalnızca ambalajdan türetildi)
