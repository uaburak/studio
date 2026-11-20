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

## Faz 0 arka ucu (yapıldı, 2026-11-20) — UI dalgaları için API

- `ApprovalRequest`: `id, brandId, contentId|null, productId|null, conversationId|null, messageId|null,
  kind (product_image|variant|product_photo_upgrade), assetIds[1–4], checkReport {passed, items[{aspect, ok, note}], summary}|null,
  status (pending|approved|rejected|superseded), slotId, replacesAssetId, approvedAssetId, sourceJobId,
  regenerateJobId, decisionNote, canRegenerate, createdAt, updatedAt, decidedAt`.
- `GET /api/approvals?brandId&contentId&conversationId&status(pending varsayılan|all)&limit&cursor` → `{items, nextCursor}`.
- `GET /api/approvals/{id}`; `POST …/approve {assetId?}`, `POST …/reject {note?}`,
  `POST …/regenerate {preserveLabelComposite?, instructions?}` → `{approval, content|null, product|null, job|null}`.
- Worker: `POST /api/worker/approvals` (`ApprovalCreate`).
- `Content.pendingApprovals: number` (liste ve detay). Canlı güncelleme: `/api/jobs/stream` →
  `{type: "approval.updated", approval}`.
- Sohbet mesaj parçası: `{type: "approval_request", approvalId}`.
- `@` adları: `Message.entityMentions [{kind: product|content, id, name, start, end}]` (UTF-16);
  `BrandProduct.slug`; `GET /api/brands/{brandId}/mention-candidates` →
  `{items: [{kind, id, slug, label, imageAssetId|null, detail, pendingApprovals}]}`.
- Motor: `GenerationEngine = wecra|html|svg|code` (hazır: html); `Brand.defaultEngine|null`,
  `Brand.imageStylePreset` (string).

## Faz 1 arka ucu (worker, yapıldı) — ürün görseli hattı

- `ImageGeneratePayload` yeni alanlar: `productIds` (en çok 4; birebir tarif + kontrol açılır), `style`
  (yoksa `Brand.imageStylePreset`; `""` = stil yok), `variant {index, count}`.
- Akış (`apps/worker/src/image/`): `references.ts` (açıya göre fotoğraf seçimi, karar yoksa ilk 3) →
  `product-description.ts` (Apple Vision OCR + Gemini Pro/Claude ile birebir tarif; foto başına
  `stateDir/product-descriptions/<assetId>-<sha256>.json` önbelleği) → `product-prompt.ts` (yalnızca
  kadraj/ortam/ambiyans/ışık/kalite değişir kuralı) → Gemini → `verify.ts` (OCR ile satır satır
  etiket karşılaştırması + model; `checkReport` 8 başlık: Etiket yazısı, Logo, Şekil ve oranlar,
  Kapak, Renkler, Desen ve doku, Eklenen ya da eksik öğe, Gerçekçilik ve kalite) → `approval.ts`.
- `approval` varsa yuva doldurulmaz; `POST /api/worker/approvals` ile kayıt açılır. Hiçbir zaman
  kendiliğinden yeniden üretilmez. Kesip yapıştırma (`preserveProductLabel`) yalnızca istekte açıkça
  varsa çalışır.
- `ApprovalCreate.chatMessage {text}` (yeni, isteğe bağlı): `conversationId` varsa API sohbete
  çalışmadan bağımsız, `complete` bir asistan mesajı ekler: parçalar `[{type:"text", text},
  {type:"approval_request", approvalId}]`, `runId: null`; kaydın `messageId`'si o mesaj olur.
- Sohbet araçları: `generate_ai_image` (`referenceProducts`, `view`, `style`, `variants` 1–4; her
  varyant ayrı iş ve ayrı onay kartı, tür `variant`), `get_product` (foto başına `quality`,
  `lowQualityPhotos`), `upgrade_product_photo` (beyaz zemin stüdyo çekimi →
  `product_photo_upgrade`, `replacesAssetId`).
- HTML postun "AI görsel" yuvası (`generate/slot-images.ts`): `generate_post` (`imageSlot: ai_generate`)
  tek bir ücretli izin kartı gösterir ("Ürün görseli de üreteyim mi?", bütün varyantları kapsar;
  `aiImage: false` ile sorulmaz). İzinle `ContentGeneratePayload.slotImage {consented: true,
  productIds?, view?, style?, prompt?, conversationId?}` gider (plan kalemleri: `PlanGenerate.slotImage`,
  yalnızca `ai_generate` kalemlere kopyalanır; `accept_and_generate_plan {aiImages: true}`). Tasarım
  sürümü kaydedilince worker her boş yuva için bir `image.generate` işi açar: ürün fotoğrafları
  (açıya göre), `approval {kind: product_image, contentId, slotId, conversationId, productId}`, yuva
  oranına en yakın en-boy, varyant postlarda `variant {index, count}`. Yuva yalnızca onayla dolar.
  İzin yoksa iş açılmaz; aynı üretim işinin yeniden denemesi ikinci kez ücret ödetmez
  (`stateDir/slot-images/<jobId>.json`).

## Faz 2 — Wecra motoru (yapıldı)

- `READY_GENERATION_ENGINES = [wecra, html]`. `content.generate` `engine: wecra` (`apps/worker/src/generate/wecra/`):
  worker marka bağlamını, yerleştirilebilir görselleri (logolar/marka görselleri, @görseller, ürün
  fotoğrafları; hepsi assetId ile) okur, modelden boş karelere (`"frame:N"`) Wecra işlemleri + açıklama +
  hashtag ister; Mac'teki tuval çalıştırıcısı `canvas.create` ile boş Wecra belgesini (1080×1350; story
  1080×1920; "kare format" denirse 1080×1080) kurar, işlemleri uygular, kareleri dışa aktarır ve
  `editorDocument`'lı `generated` sürümü kaydeder. Sonra 1 + `designFixPasses` (en çok 3) eleştiri →
  düzeltme turu (`canvas.apply`, `ai_edit`); uygulanamayan düzeltme tasarımı bozmaz. Kontroller son
  sürümde çalışır. `ai_generate` yuvası "AI görsel" adlı katmandır; izin varsa `queueSlotImageJobs` o
  katmanın Wecra id'siyle iş açar. Tuval postunda onay görseli `canvas.apply place_image` ile yerleştirir.
- `canvas.create` (çalıştırıcı işi): boş kareler + isteğe bağlı işlemler; SVG logo `image: {assetId}` ile
  vektör katman olur. Mac'te "+ Yeni post → Boş tuvalden yeni post" aynı işi yapay zekâsız çalıştırır.
- `content.details` ("Bilgileri üret", worker): tasarımın renderları ve metin katmanlarından açıklama,
  hashtag, başlık, alt metin, ilk yorum yazar; sürüm oluşturmaz, onaylı postun açıklamasına ve elle
  yazılmış alt metne dokunmaz. Post düzenleyicisinin Açıklama sekmesinde.
- Sohbet: `@post` satırı tuval postunu "tuvalde" diye işaretler (`TurnContent.canvas`); "devamını getir"
  kuralı canvas araçlarıyla, elle yapılan katmanları koruyarak tamamlatır; `canvas_outline` `brandAssets` verir.

## Faz 3 — SVG motoru (yapıldı)

- `READY_GENERATION_ENGINES = [wecra, html, svg]` (Mac ayarları ve iOS `GenerationEngine.ready` aynı).
  `content.generate` `engine: svg` (`apps/worker/src/generate/svg/`): HTML/Wecra ile aynı marka girdileri
  (onaylı profil belirteçleri, renkler, fontlar, logolar, facts/izinli sayılar, ses, skill'ler, @görseller,
  ürün fotoğrafları, internet). Model her slaytı tek bir `<svg>` olarak (1080×1350; story 1080×1920; "kare
  format" denirse 1080×1080) ve açıklama + hashtag'leri yazar. Görseller yol ile: `/brand/logos/…`,
  `/media/<assetId>.<ext>`; fontlar `style="font-family: var(--font-<rol>)"` ile brand.css'in
  `@font-face`'lerinden.
- Saklanan slayt: `<html data-studio-engine="svg">` içinde brand.css bağlantısı, SVG'nin kendi `<style>`'ı
  (başa taşınır) ve `<svg>` — motorun kaynağı budur (`readSvgSlide`, `isSvgSlideHtml`). Temizlik iki kat:
  SVG geçişi (tek kök, artboard ölçüsü, `@import`/`@font-face` yok, `<a>` açılır, yalnızca markanın ve
  sunulan `/media` görselleri) + design-kit HTML temizleyicisi (script, foreignObject, on…, animasyon,
  dış adresler gider; SVG `<image>` yalnızca `/brand/`, `/media/` ile kalır) + son denetim.
- Render: Chromium (design-kit `Renderer.renderAndInspect`). resvg seçilmedi: marka fontları WOFF2 ve
  `@font-face` ile geliyor (resvg ikisini de okumaz), metin ölçümü ve kontrast için sayfa gerekiyor.
  Aynı sayfada her `<text>` kutusu, fontu, boyutu, rengi, görseller ve yuva işaretleri ölçülür; yazısız
  ikinci çekimle kontrast. Bulgular design-kit kural adlarıyla (`text-outside-artboard`, `safe-area`,
  `min-font-size`, `font-family`, `font-load`, `text-overlap`, `text-logo-overlap`, `image-distorted`,
  `slot-empty`, `slot-ratio-mismatch`, `unverified-number`, `contrast`, `network-request`) LintReport olur.
- Döngü: üretim → eleştiri/düzeltme (render + rapor) bir kez her zaman, sonra hata kaldıkça; toplam
  1 + `designFixPasses` (en çok 3) tur. En iyi sürüm (önce yapılamayan slayt, sonra hata sayısı) yüklenir,
  `generated` sürüm kaydedilir, kontroller motorun raporlarıyla çalışır (SVG'ye otomatik HTML yaması yok;
  `content.check` ve render sonrası kontroller de SVG ölçümünü kullanır).
- Düzenleme yalnızca sohbetten: `revise_post` SVG sürümünde `engine: svg` gönderir; motor belirtilmemiş
  bir `baseVersion + instructions` işi de taban sürüm SVG ise SVG motoruna gider (toplu düzeltme dahil).
  Saklı SVG + render'lar + talimat → tek düzenleme çağrısı → `ai_edit` sürüm. Mac'te SVG sürümü tuvalde
  salt okunur açılır ("SVG motoruyla üretildi; … sohbetten iste"), sohbet notu `revise_post` der.
- "AI görsel" yuvası: `<rect data-slot="ai-image" data-slot-ratio="W:H" data-slot-label="AI görsel" …/>`.
  İzin varsa `queueSlotImageJobs` bu işaretle iş açar; onay (`approvals.ts`) SVG sürümünde
  `content.render {version, slotAssignments}` kuyruğa alır, worker işareti aynı kutuda
  `<image … preserveAspectRatio="xMidYMid slice">` yapar (yuvarlak köşe clipPath ile korunur), yeniden
  render eder, yeni sürüm. Reels SVG ile üretilmez.

## Faz 4 — Kod motoru (yapıldı)

- `READY_GENERATION_ENGINES = [wecra, html, svg, code]` (Mac ayarları ve iOS `GenerationEngine.ready` aynı;
  dört motor da hazır). `content.generate` `engine: code` (`apps/worker/src/generate/code/`): diğer motorlarla
  aynı marka girdileri (onaylı profil belirteçleri, renkler, marka yazı tipleri **dosya olarak**, logolar,
  marka görselleri, facts/izinli sayılar, ses, skill'ler, @görseller, ürün fotoğrafları, internet). Model post
  başına **tek bir Python 3 programı** yazar (Pillow, skia-python, numpy, OpenCV); program bütün slaytları
  artboard ölçüsünde (1080×1350; story 1080×1920; "kare format" 1080×1080) çizip PNG olarak kaydeder; açıklama ve
  hashtag'ler yapılandırılmış çıktıdadır.
- Yardımcı modül `apps/worker/code-engine/studio_brand.py` (`import studio_brand as sb`): `sb.W/H`, güvenli
  alan (`sb.SAFE_*`), renkler (`sb.color("ink")`), marka yazı tipleri (`sb.font(rol, boyut, ağırlık)`; değişken
  font ağırlığı ayarlanır; latin / latin-ext alt kümelerine bölünmüş fontlarda her harf onu içeren dosyadan
  çizilir), görseller adıyla (`sb.place(img, "logo/…" | "@image" | "product/…-1", …)`), `sb.text(...)` (sarar,
  çizer ve **kaydeder**: kutu, font, boyut, renk, altındaki zemin), `sb.measure` / `sb.fit_size`,
  `sb.slot(img, x, y, w, h, ratio, label="AI görsel", id="ai-image")`, efektler (doğrusal/radyal degrade,
  yuvarlak maske, gren, gölge, vinyet, skia yüzeyi), `sb.canvas(n)` / `sb.save(img)`. Kayıt `out/record.json`.
- **Kapalı alan** (`code/sandbox.ts`, karar 4): macOS `sandbox-exec` profili `(deny default)` ile başlar ve
  yalnızca şunlara izin verir: okuma — venv, temel Python, işin `input/` klasörü (input.json, program.py,
  fontlar, görseller, run.py + studio_brand.py kopyası), `out/` ve `tmp/`, sistem kütüphaneleri ve fontları
  (`/System`, `/usr/lib`, `/usr/share`, `/Library/Fonts`); yazma — **yalnızca** işin `out/` ve `tmp/`
  klasörleri; çalıştırma — yalnızca Python yorumlayıcısı (fork yok, başka program yok); ağ — yalnızca giden
  (dinleme/gelen bağlantı yok). Kullanıcının ev klasörüne iş klasörü dışında erişim yok. Ortam değişkenleri
  temizlenir (anahtar/jeton gitmez), 60 sn duvar saati sınırı (aşılırsa süreç grubu öldürülür), 2 GB bellek
  tavanı (RSS izlenir), dosya başına 64 MB, `out/` toplam 200 MB, CPU sınırı. İkinci kat: statik denetim —
  önce TypeScript'te (`code/check.ts`), sonra kapalı alanda `run.py` sözdizim ağacıyla: izinli modüller
  PIL, skia, numpy, cv2, math, random, json, os.path, pathlib, studio_brand, colorsys, typing, dataclasses,
  functools, itertools (+ collections, statistics, textwrap, unicodedata, string, re, enum, copy); `subprocess`,
  `os.*` (os.path dışı), `ctypes`, soket, `eval/exec/compile/open/getattr`, dunder kaçışları, `Image.show`,
  `cv2.VideoCapture` reddedilir.
- Döngü: program → ön denetim → kapalı alanda çalıştırma → çıktı denetimi (slayt sayısı, ölçü, boş olmama) +
  kayıttan lint (SVG motorunun kuralları: `text-outside-artboard`, `safe-area`, `min-font-size`,
  `font-family`, `text-overlap`, `unverified-number`, `slot-empty`, `slot-ratio-mismatch`; ayrıca
  kaydedilen zeminden `contrast` ve sarma genişliğini aşan `text-overflow-box`). `sb.text` mürekkep kutusunun
  yanında satır kutularını da kaydeder (`lineBox`: ilk satırın üstünden son satırın satır aralığına; `next_y` döner);
  iki metnin satır kutuları 1 px'ten fazla çakışırsa `text-overlap` (harfler birbirine değmese de, örn. bir satır
  fazla saran paragraf alttaki başlığa biniyor). `allow_overlap=True` bilerek üst üste binen metni işaretler. Render'lar + rapor modele
  gider; 1 + `designFixPasses` (en çok 3) turda program yeniden yazılır. Python hatası (traceback) ya da
  reddedilen program da modele döner ve bir tur sayılır. En iyi sürüm yüklenir.
- Sürüm: slaytlar render'ı gösteren küçük HTML belgeleridir (`<html data-studio-engine="code">`,
  `<img src="/media/<assetId>.jpg">`); `<meta name="studio:code-record">` programın o slayta çizdiklerini,
  ilk slaytta `studio:code-program` (base64 Python) ve `studio:code-inputs` (görseller, dolu yuvalar, ölçü,
  güvenli alan, profil sürümü) taşır (`isCodeSlideHtml`, `codeSlideSlots`, `chatOnlyEngineOf` sözleşmede;
  `readCodeSource` worker'da). Kontroller ve sonraki render'lar Python çalıştırmadan kayıttan lint eder.
- Düzenleme yalnızca sohbetten: `revise_post` kod sürümünde `engine: code` gönderir (motorsuz
  `baseVersion + instructions` de kod sürümünde koda gider); saklı program + render'lar + talimat → program
  yeniden yazılır → `ai_edit`. Mac'te kod sürümü tuvalde salt okunur açılır ("Kod motoruyla üretildi;
  tuvalde düzenlenmez…", SVG kilidiyle aynı `chatOnlyEngineOf`), sohbet notu `revise_post` der. Katman yaması
  kod sürümünde reddedilir.
- "AI görsel" yuvası: `sb.slot(...)` yer tutucu çizer ve kaydeder; izin varsa `queueSlotImageJobs` iş açar.
  Onay (`approvals.ts` `engineSlot`) kod sürümünde `content.render {version, slotAssignments}` kuyruğa alır;
  worker saklı programı görsel o yuvaya atanmış olarak **yeniden çalıştırır** (`executeCodeSlotFill`), yeni
  `manual_edit` sürüm, kontroller. Varyantlar (1–4) ve plan üretimi `engine: code` ile çalışır; Reels reddedilir.

### Kod motorunun Python ortamı (kurulum)

- Ortam, worker'ın durum klasöründe proje-yerel bir virtualenv'dir: Mac uygulamasında
  `~/Library/Application Support/Studio/worker/code-engine/venv` (genel olarak `<STUDIO_STATE_DIR>/code-engine/venv`).
  Sabitlenmiş paketler `apps/worker/code-engine/requirements.txt` (Pillow 11.3.0, numpy 2.0.2 / 2.2.6,
  opencv-python-headless 5.1.0.95, skia-python 144.1; yalnızca hazır wheel). Global kurulum ya da sudo yok.
- Temel Python: `STUDIO_CODE_PYTHON`, yoksa Homebrew `python3`, yoksa Xcode Komut Satırı Araçları'nın
  `/usr/bin/python3`'ü (3.9+; araçlar kurulu değilse kullanılmaz, kurulum penceresi açılmasın diye).
- İlk kod işinde worker ortamı kendisi kurar (paketler bir kez indirilir, ~1 dk); iş bu sürede "Kod motoru
  için Python ortamı hazırlanıyor" der. Kurulamazsa iş açık bir Türkçe hatayla biter.
- Tek seferlik elle kurulum / onarım: proje klasöründe `pnpm -C apps/worker code-engine:setup` (önce
  `STUDIO_STATE_DIR`, yoksa Mac uygulamasının worker klasörü). Ortamı kurar ve kapalı alanda küçük bir deneme
  programı çalıştırır. `requirements.txt` değişirse ortam yeniden kurulur (`runtime.json` özeti).
- Paketlenmiş uygulamada `code-engine/` klasörü `worker/main.js`'in yanına kopyalanır (`build-host.mjs`).

## Kapanan boşluklar (2026-11-20)

- **Şablondan post → AI görsel yuvası.** Şablonla üretilen postta boş kalan görsel yuvası (resim
  verilmemiş, kilitsiz `slot` alanı; tuval şablonunda ayrıca resimsiz "AI görsel" katmanı) motorlarla
  aynı hattan dolar: izin varsa sürüm kaydedilince `queueSlotImageJobs` iş açar (`template.ts`
  `templateHtmlSlots` / `templateCanvasSlots`; tuvalde `slotId` = Wecra katman id'si, onay `canvas.apply
  place_image` ile yerleştirir). Sohbette `generate_from_template` boş yuva varsa `generate_post` gibi tek
  ücretli izin kartı gösterir (yeni argümanlar `products`, `imageView`, `imageStyle`, `imageBrief`,
  `aiImage`; sonuçta `emptySlots`, `slotImage`). API'de `TemplateUse` yeni alanlar: `slotImage`
  (`SlotImageRequest`, açıkça verilmezse ücretli görsel yok; verilince iş `imageSlot: ai_generate` olur,
  `conversationId` istekten tamamlanır) ve `imageBrief`. Ürünler markanın olmalı (400).
- **Plan kalemleri ürünlerini tutar.** `PlanItem.productIds: string[]` (eski kalemler `[]`) ve
  `imageView: string|null`; `PlanItemInput` / `PlanItemPatch` isteğe bağlı aynı alanlar (en çok 4,
  tekrarsız, markanın ürünü; alanı içermeyen toplu düzenleme mevcut ürünleri korur). Migration
  `0025_plan_item_products` (`plan_items.product_ids`, `image_view`). `propose_plan` kalemi `products`
  (slug/ad/id) ve metinlerdeki `@slug`'lardan doldurur, `imageView` alır. `plans.generate` her kalemin
  (hâlâ var olan) ürünlerini `ContentGeneratePayload.productIds`'e ve istek ürün söylemiyorsa
  `slotImage.productIds` / `view`'e koyar; `accept_and_generate_plan` izin kartında ürün adlarını yazar.
- **Reddedilen adaylar çöpe.** Onay isteği reddedilince, yerine yenisi gelince (`supersedesId`,
  "Yeniden üret") ya da çok adaylı istekte seçilmeyen adaylar için: başka yerde kullanılmayan aday
  görseller `deletedAt` ile 30 günlük çöpe gider (`trashUnusedCandidates`). Korunanlar: onaylanan görsel,
  sürümde/üründe/şablonda/marka kitinde kullanılan, başka bekleyen istekte aday olan, onaylanmış bir
  istekte seçilen, ya da bekleyen/reddedilmiş bir isteğin (kendisininki dahil) saklı `request`
  yükünde geçen görseller — "Yeniden üret" referanslarla çalışmaya devam eder.
