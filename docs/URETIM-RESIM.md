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
