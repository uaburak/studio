---
name: product-reference-image
description: Gerçek bir ürün fotoğrafını referans alarak AI ile yeni ürün görseli üretir (tarla, stüdyo, yaşam tarzı sahnesi, reklam ya da sosyal medya görseli) ve etiketteki yazıları bozmadan korur. Kullanıcı bir ürün ya da ambalaj fotoğrafı (torba, şişe, kutu, teneke, poşet; üzerinde yazı ya da logo olan her şey) verip "buna bir sahne yap", "ortamda göster", "profesyonel çekim gibi olsun", "ürün görseli üret" dediğinde, etiketten hiç söz etmese bile bu skill'i kullan. Önce referanstaki etiket metnini okur, metni görsel modeline birebir verir, sonra üretilen görseldeki etiketi doğrular.
---

# Ürün referansından görsel üretimi

## Neden bu yöntem

Görsel modelleri referanstaki yazıyı kopyalamaz, yeniden çizer. Metni bilmediğinde
harflere benzeyen şekiller uydurur. Venta Borinc testinde (2026-11-16) yalnızca
"etiketi aynen koru" demek yetmedi: "KULLANIMDA GÜVENLİK KURALLARI" başlığı
"KULLANISMA GÖYERLİK KUBALLARI" çıktı. Aynı sahne, etiket metni talimata birebir
yazılarak üretildiğinde logo, ürün adı, alt başlık ve bütün bölüm başlıkları doğru
çıktı. Bu yüzden sıra şudur: önce oku, sonra üret, sonra doğrula.

## Adımlar

### 1. Etiketi oku

Referansın yanında `<ad>.label.md` dökümü varsa onu kullan; yoksa çıkar.

- `scripts/zoom.sh` ile etiketi bölgelere ayırıp büyüt, her bölgeyi oku.
- Okuduğun her satırı konumuyla birlikte yaz (üst bant, orta blok, sol sütun, sağ sütun, kutular).
- Emin olamadığın satırı "düşük güven" diye işaretle. Tahmin yazma: uydurulmuş bir
  telefon numarası ya da doz, bozuk harften daha zararlıdır.
- Kullanıcıda etiketin asıl dosyası ya da metni varsa onu iste; fotoğraftan okumaktan
  her zaman daha güvenilirdir.

### 2. Yazıları iki sınıfa ayır

- **A sınıfı: birebir olmalı.** Referansta normal bakışta okunan her şey: marka,
  logo yazısı, ürün adı, alt başlık, bölüm başlıkları, kalın satırlar.
- **B sınıfı: elden geldiğince.** Referansta zaten okunmayan ince yazılar. Bunlar
  için birebir şartı aranmaz (sahibinin tercihi, 2026-11-16).

Bir uyarı: üretilen görsel 2K olduğu için referansta okunmayan ince yazı çıktıda
okunur hale gelebilir. Telefon, doz, lisans ve tescil numarası gibi değerler çıktıda
okunuyor ve yanlışsa bunu raporda ayrıca belirt; karar kullanıcının.

### 3. Talimatı yaz

Talimat İngilizce, etiket metni kendi dilinde ve tırnak içinde olur. Bölümler:

1. **References:** 1. görsel ürünün tamamı, 2. görsel etiketin yakın planı.
2. **Scene:** ortam, ışık, mercek, kompozisyon. Ürün karenin yaklaşık yüzde 70
   yüksekliğini kaplasın; etiket büyüdükçe yazı doğruluğu artar.
3. **Label: reproduce exactly:** dökümdeki metin, konum konum, birebir.
4. **Language:** hangi satırların hangi dilde olduğu. Türkçe metinle birlikte
   İngilizce ya da marka satırı varsa "I noktasız yazılır" diye belirt; yoksa model
   "FERTILIZER" kelimesini "FERTİLİZER" yapar.
5. **Critical values:** telefon, doz, lisans/tescil numarası gibi rakamları ayrı
   bir satırda tekrar listele.

Çalışan örnek: `spikes/gemini-image/prompts/venta-borinc-field.txt`.

### 4. Üret

```bash
node --env-file=.env .claude/skills/product-reference-image/scripts/generate.mjs \
  --model gemini-nano-banana-2.1 --aspect 4:5 --size 2K \
  --ref <urun.png> --ref <etiket-yakin-plan.png> \
  --prompt-file <talimat.txt> --out <cikti-klasoru>
```

- Model: `gemini-nano-banana-2.1`. Testte referansı daha yüksek çözünürlükte
  okuduğu için etiket metnini `gemini-3-pro-image` modelinden daha doğru yazdı.
- Boyut: 2K (4:5 için 1856×2304). Çıktıyı küçültme.
- Etiketin yakın planı için ürünü sıkıca kırpıp büyüt (`scripts/zoom.sh`).
- Anahtar `.env` dosyasından okunur; hiçbir yere yazdırma.

### 5. Doğrula

Üretilen görselde etiketi yine bölgelere ayırıp büyüt ve dökümle satır satır
karşılaştır. Küçültülmüş önizlemeye bakarak "etiket doğru" deme; hatalar ancak
yakın planda görünür.

### 6. Düzelt

A sınıfında hata varsa talimatta o satırı açıkça düzelterek bir kez daha üret. İki
denemeden sonra hâlâ hatalıysa kullanıcıya söyle.

Denenmiş ama sonucu henüz incelenmemiş iki yol var (çıktıları
`spikes/gemini-image/out/venta-v3-4k` ve `venta-v3-fix` klasörlerinde): 4K üretim
ve yalnızca hatalı satırları düzelten ikinci geçiş
(`spikes/gemini-image/prompts/venta-borinc-fix.txt`). İşe yaradıkları doğrulanırsa
bu adıma eklenir. Kesin çözüm, sahneyi AI ile üretip gerçek ürün görüntüsünü üstüne
bindirmektir; bu yol henüz kurulmadı.

### 7. Raporla

Kullanıcıya şunları söyle: hangi satırlar birebir, hangileri değil, çıktıda okunur
hale gelip yanlış olan değer var mı. Doğrulamadığın bir etiketi doğru diye sunma.

## Dosyalar

- `scripts/generate.mjs`: Gemini API çağrısı. `--ref` birden çok kez verilebilir.
- `scripts/zoom.sh`: bir bölgeyi kırpıp büyütür (macOS `sips`).
- Dökümler referansın yanında durur: `urun.png` → `urun.label.md`.

## Yayın notu

AI ile üretilen ürün görselleri Instagram'a gönderilirken `is_ai_generated` işareti
eklenir. Gemini çıktılarında görünmez SynthID filigranı bulunur.
