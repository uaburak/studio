# Resim (post) üretimi — plan ve kararlar

Burak'la 2026-11-20'de kararlaştırıldı. Bu belge resim/post üretiminin yeni halinin tek kaynağıdır;
Reels ve hikâye sonra ayrı ele alınacak.

## Kararlar

1. **Üretim motorunu kullanıcı seçer.** Sohbette üretim istenince ajan sorar: Wecra, HTML, SVG ya da
   Kod. Markaya varsayılan motor kaydedilebilir (isteğe bağlı).
2. **Ortak çıktı.** Her motor aynı şeyi teslim eder: 1080×1350 görsel(ler), açıklama + hashtag'ler,
   motorun kaynağı. Kontroller, onay, zamanlama ve yayın hepsinde aynı çalışır.
3. **Düzenleme.** Wecra ile yapılanlar tuvalde (ve sohbetten `canvas_edit` ile) düzenlenir. HTML, SVG
   ve Kod motorlarının çıktıları yalnızca sohbetten düzenlenir.
4. **İnternet.** Üretim ajanı internete erişir (güncel tasarım trendleri, referans araştırması).
   Kod motoru dilini kendisi seçmez: Python (Pillow, skia-python, numpy, OpenCV), kapalı bir alanda
   (yalnızca kendi geçici klasörüne yazar, süre sınırı, marka yazı tiplerine okuma erişimi,
   internet açık).
5. **Varyant sayısı.** Ajan "Kaç tane üreteyim?" diye sorar (üst sınır 4; her görsel ücretli). Her
   varyant hazır oldukça sohbete düşer ve bir onay bekleyen kayıt olur.
6. **@takma adlar.** Sohbete sürükle-bırak, yapıştır ya da yükleme ile gelen görseller `@image`,
   `@image-1`… olur. Ürünler kendi adlarıyla çağrılır (`@boro`, `@venta-boro`), postlar da
   (`@postadı`). Uygulamada zaten adı olan görseller kendi adlarıyla anılır.
7. **Ürün referansları.** Bir ürünün bütün fotoğrafları (ön, arka, yan etiket…) ajanın elindedir;
   isteğe göre (ör. "sola bakan") uygun açıyı seçer. Karar veremezse en fazla 3 referans iletir.
8. **Birebir tarif.** Gemini'ye gitmeden önce etiketteki her yazı, renk, desen, şişe/paket şekli ve
   doku okunur ve prompta harfi harfine yazılır. Model yalnızca kadrajı, ortamı, ambiyansı, ışığı ve
   kaliteyi değiştirir. Stil (vintage, retro…) isteğe bağlı bir alandır: boş bırakılabilir; markaya
   ön ayar olarak da kaydedilebilir.
9. **Kontrol yapay zekâda.** Çıktı ürünün kendi fotoğraflarıyla ve bilgileriyle karşılaştırılır.
   Ölçüt: "ürünü profesyonel bir ürün fotoğrafçısına vermişim, o çekip teslim etmiş" gibi olmalı —
   fiziksel hiçbir değişim yok (etiket yazısı, şekil, oran, kapak, renk, desen, doku; eklenen ya da
   eksik öğe yok). Kontrol, hatalı kısımları tek tek yazan bir rapor üretir.
10. **Etiketi kesip yapıştırma** (bugünkü `preserveProductLabel`) varsayılan değildir; "Yeniden
    üret" derken ayrı bir seçenek olarak sunulur: "Etiketi birebir koruyarak yerleştir".
11. **Sormadan üretim yok.** Her yeniden üretim kullanıcıya sorulur. Onaylar telefondan da verilir.
12. **Onay akışı.** Sohbette görsel + kontrol raporu ("şu kısımlar hatalı geldi") ve altında
    **Onayla / Reddet / Yeniden üret** düğmeleri. Post bu sürede "Onay bekliyor" olarak postlara
    kaydedilir. Aynı düğmeler Mac'te ayrıntılar panelindeki **Onay bekleyenler** bölümünde ve
    iPhone'da sağ üst ⋯ menüsündeki **Onay bekleyenler** ekranında da çıkar; bir kayda dokununca o
    sohbet mesajına gidilir.
13. **Kalitesiz ürün fotoğrafı.** Ajan sorar: "Bu ürünün resmi kalitesiz, iyileştireyim mi?" Onay
    gelirse beyaz zeminde, stüdyo ışığında, yüksek çözünürlüklü yeni bir görsel üretir ve "Olmuş
    mu?" diye sorar. Onaylanırsa yeni görsel ürüne yüklenir; eskisi 30 gün çöpte durur (geri
    alınabilir), sonra silinir.
14. **Wecra.** Ajan boş bir Wecra belgesinden Wecra'nın kendi araçlarıyla sıfırdan tasarlayabilir.
    Postlar ekranında "Boş tuvalden yeni post" girişi olur (yapay zekâ çalışmaz). Tuvalde
    **Bilgileri üret** düğmesi görsele dokunmadan açıklama, başlık, hashtag'ler ve post bilgilerini
    tasarıma göre ve markanın şablonları, brifleri, kurallarıyla doldurur. Yarım bırakılan bir
    tasarım sohbette "@postadı bu tasarımı geliştir, devamını getir" ile bitirtilebilir.
15. **SVG motoru**: ajan tasarımı vektör olarak yazar; hızlı, ucuz, her seferinde aynı sonuç.

## Fazlar

- **Faz 0 — Ortak temeller:** motor seçimi (yalnızca HTML çalışır halde başlar), varyant sayısı,
  `@ürün` / `@post` takma adları, onay bekleyen kayıtları (veri modeli + API + "Onay bekliyor"
  durumu), üretim ajanına internet.
- **Faz 1 — Ürün görseli hattı:** referans seçimi, birebir tarif, Gemini üretimi, yapay zekâ
  kontrolü, sohbette kart + düğmeler, Mac paneli, iPhone ekranı, kesip yapıştırma seçeneği,
  iyileştirme akışı.
- **Faz 2 — Wecra motoru:** boş belgeden üretim, "Boş tuvalden yeni post", "Bilgileri üret",
  `@post` ile devam ettirme.
- **Faz 3 — SVG motoru.**
- **Faz 4 — Kod motoru** (Python, kapalı alan).
