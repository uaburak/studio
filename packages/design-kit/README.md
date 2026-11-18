# @studio/design-kit

Studio'nun tasarım motoru kütüphanesi: tasarım sözleşmesi v1, katman modeli, yama işlemleri,
temizleyici (sanitiser), marka CSS'i, denetleyici (linter), platform ön ayarları ve Chromium
renderer'ı. F0-2 denemesinin (`spikes/design-render`) doğrulanmış davranışını ürün koduna taşır;
Mac worker, web editörü ve üretim promptları aynı kodu kullanır.

- **İzomorfik çekirdek**: tarayıcıda ve Node'da başsız tarayıcı olmadan çalışır. Dış bağımlılık
  yalnızca `parse5` (Chromium ile aynı ağacı kuran, standarda uygun HTML ayrıştırıcı) ve `zod`.
- **Renderer** ayrı giriş noktasıdır (`@studio/design-kit/render`), yalnızca Node: Playwright
  Chromium + `sharp`. Tarayıcı paketine hiç girmez (bir test bunu esbuild ile kanıtlar).
- Sözleşme metni İngilizcedir, çünkü üretim promptları İngilizce (denemedeki gibi).

## Paket haritası

| Giriş noktası                              | Klasör         | İçerik                                                                                   |
| ------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------- |
| `@studio/design-kit`                       | `src/index.ts` | Aşağıdaki izomorfik modüllerin hepsi (renderer hariç)                                    |
| `@studio/design-kit/contract`              | `src/contract` | Sabitler, katman modelinin zod şemaları, `DESIGN_CONTRACT_MD`                            |
| `@studio/design-kit/document`              | `src/document` | `parseSlide` (HTML → tipli katman ağacı), `createSlideHtml`                              |
| `@studio/design-kit/patch`                 | `src/patch`    | 17 yama işlemi, tersleri, işlem günlüğü şeması                                           |
| `@studio/design-kit/sanitize`              | `src/sanitize` | Temizleyici, CSP, korumalı önizleme `srcdoc`'u                                           |
| `@studio/design-kit/brand`                 | `src/brand`    | Marka belirteçleri şeması, `brand.css` üreteci, marka bileşenleri ve kayıt defteri       |
| `@studio/design-kit/lint`                  | `src/lint`     | Kural kaydı, statik denetim, sayfa içi betik, piksel kontrastı, boşluk/carousel denetimi |
| `@studio/design-kit/canvas`                | `src/canvas`   | Tuvalde (Wecra) kaydedilen karelerin bilgisi (`CanvasFacts`), kare HTML'i ve denetimleri |
| `@studio/design-kit/presets`               | `src/presets`  | Platform ön ayarları (boyut, güvenli alan, dışa aktarım sınırları) ve doğrulayıcı        |
| `@studio/design-kit/render`                | `src/render`   | **Yalnızca Node.** Renderer, varlık çözücüler, PNG → sRGB JPEG, PDF                      |
| `@studio/design-kit/DESIGN_CONTRACT.v1.md` | `contract/`    | Sözleşmenin sürümlü Markdown metni                                                       |

`src/html` ortak altyapıdır: parse5 yardımcıları (kaynak konumlarıyla) ve kaynak aralıklarını
koruyan küçük bir CSS Syntax Level 3 ayrıştırıcısı (kaçış dizilerini çözer, `\75 rl(` = `url(`).

## Temel tasarım kararları

- **Ekleme (splice) tabanlı düzenleme.** Hiçbir işlem HTML'i yeniden yazdırmaz; değişiklik kaynak
  metne minimum ekleme olarak uygulanır. Dokunulmayan işaretleme bayt bayt aynı kalır, temiz bir
  belge temizleyiciden aynen çıkar, `parseSlide(x).html === x`.
- **Her işlemin tersi bayt bayt geri getirir.** Geri al sonrası içerik özeti (`computeContentHash`)
  değişmez, dolayısıyla onay da geçerli kalır. Rastgele işlem dizileriyle (fast-check) test edilir.
- **Sonuca göre doğrulama.** Her işlemden sonra belge yeniden ayrıştırılır: yeni yapısal sözleşme
  hatası, temizleyicinin sileceği yeni bir şey, dokunulmayan bir katmanın değişmesi ya da kaybolması
  işlemi reddeder (`PatchError`, sabit `code`).
- **Editör dönüşümleri** `translate` / `rotate` / `scale` CSS özellikleriyle yazılır: grup içindeki
  kardeşler yeniden akmaz, tasarımın kendi `transform`'u ezilmez.
- **Tek güvenlik politikası.** Renderer CSP'yi yanıt başlığı olarak, editör önizlemesi `<meta>`
  olarak kullanır; ikisinde de betik, çerçeve, form, bağlantı kapalı; görsel/font/stil yalnızca
  varlık kökeninden.

## Mac worker nasıl kullanır

```ts
import {
  brandFontFamilies,
  describeBrandCss,
  generateBrandCss,
  parseBrandTokens,
} from "@studio/design-kit/brand";
import { DESIGN_CONTRACT_MD } from "@studio/design-kit/contract";
import { lintCarousel, lintForPrompt, findUnverifiedNumbers } from "@studio/design-kit/lint";
import { PLATFORM_PRESETS, validateExport } from "@studio/design-kit/presets";
import { sanitizeSlideHtml } from "@studio/design-kit/sanitize";
import {
  combineResolvers,
  createDirectoryResolver,
  createMemoryResolver,
  createRenderer,
} from "@studio/design-kit/render";

const tokens = parseBrandTokens(profile.tokens); // BrandProfile.tokens (brand.json)
const { css, manifest } = generateBrandCss(tokens); // brand.css + prompt manifestosu
// Sistem promptu: DESIGN_CONTRACT_MD + describeBrandCss(manifest) + DESIGN.md + VOICE.md + facts

const renderer = createRenderer({
  // bir tarayıcı, her render'a ayrı context
  resolver: combineResolvers(
    createMemoryResolver({ "/brand/brand.css": css }),
    createDirectoryResolver({ brand: brandDir, media: mediaDir }), // ileride R2 çözücüsü
  ),
});

const preset = PLATFORM_PRESETS["instagram-feed-portrait"];
const html = sanitizeSlideHtml(llmHtml).html; // modelin HTML'i güvenilmez
const { jpeg, png, report, timings } = await renderer.renderAndLint({
  html,
  width: preset.width,
  height: preset.height,
  lint: {
    safeArea: preset.safeArea,
    brandFonts: brandFontFamilies(tokens),
    allowedNumbers: facts.allowedNumbers,
  },
});
// eleştiri geçişine: lintForPrompt(report) + jpeg
// carousel: lintCarousel([r1, r2, r3]); açıklama metni: findUnverifiedNumbers(caption, facts.allowedNumbers)
validateExport(preset, { format: "jpeg", width: 1080, height: 1350, bytes: jpeg!.byteLength });
const { pdf } = await renderer.renderPdf({ slides, title }); // LinkedIn belge postu, 2x JPEG sayfalar
await renderer.close();
```

- 2x çıktı: `deviceScaleFactor: 2`. Instagram 1440 px genişliği aştığında `validateExport` uyarır
  (`maxDeviceScale(preset)` = 1,33).
- `RenderError.code`: `timeout`, `aborted`, `no_resolver`, `browser`, `invalid_request`.
  Tarayıcı çökerse bir sonraki render'da yeniden açılır. `signal` ile iptal edilebilir.
- Ağ: sanal köken `https://studio.invalid`; `/brand/` ve `/media/` dışındaki her istek iptal edilir
  ve rapora `network-request` olarak düşer; tarayıcıda DNS kapalıdır (`--host-resolver-rules`).

## Web editörü nasıl kullanır

```ts
import { brandPatchContext } from "@studio/design-kit/brand";
import { parseSlide } from "@studio/design-kit/document";
import { applyPatch, revertPatches, PatchError } from "@studio/design-kit/patch";
import { buildPreviewDocument } from "@studio/design-kit/sanitize";
import { inPageInput, lintSlide, studioInPageLint } from "@studio/design-kit/lint";

const doc = parseSlide(version.slides[0].html); // doc.model.layers, doc.layer("headline")
const r = applyPatch(
  doc,
  { op: "transform", layer: "headline", translate: { x: 12, y: -8 } },
  brandPatchContext(tokens),
);
undoStack.push(r.inverse); // r.html, r.doc, r.op, r.inverse

const preview = buildPreviewDocument(r.html, {
  assets: { brand: brandBaseUrl, media: mediaBaseUrl },
});
iframe.setAttribute("sandbox", preview.iframe.sandbox); // "allow-same-origin", betik yok
iframe.srcdoc = preview.srcdoc; // CSP gömülü, URL'ler varlık sunucusuna

// Aynı sayfa içi denetim, önizleme çerçevesinin belgesi üzerinde (piksel kontrastı hariç):
const report = await lintSlide(r.html, {
  width: 1080,
  height: 1350,
  brandFonts,
  allowedNumbers,
  page: { runInPage: async (input) => studioInPageLint(input, iframe.contentDocument!) },
});
```

Yama işlemleri (`PATCH_OP_NAMES`): `setText`, `setStyle` (izin listesi), `transform`, `resize`,
`setColor` (belirteç ya da sabit renk), `setTypography`, `replaceImage`, `setImageFit` (kırpma),
`fillSlot`, `clearSlot`, `moveLayer` (z-sırası), `setVisibility`, `duplicateLayer`, `deleteLayer`,
`addLayer` (her katman türü), `insertLayer` ve `replaceLayer` (temiz, tek öğelik ham HTML; terslerde
ve "prompt ile düzelt"te tek katmanı yamamak için). Sürüm geçmişi `PatchLog` şemasıyla saklanır.

## Denetleyici

Kurallar `src/lint/rules.ts` içinde, sabit kimlikli, varsayılan önem dereceli ve aşamalıdır:

| Aşama      | Nerede çalışır                               | Örnek kurallar                                                                                        |
| ---------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `static`   | Her yerde, tarayıcısız                       | `lang`, `forbidden-element`, `css-url`, `layer-*`, `slot-*`, `logo-src`, `unverified-number`          |
| `layout`   | Chromium sayfası ya da editör iframe'i       | `text-occluded`, `safe-area`, `text-overlap`, `diacritic-collision`, `logo-clear-space`, `large-void` |
| `pixel`    | Yalnızca renderer (metinsiz ekran görüntüsü) | `contrast`, `contrast-busy-background`, `contrast-unknown`                                            |
| `render`   | Yalnızca renderer                            | `network-request`                                                                                     |
| `carousel` | Tüm slaytların raporları                     | `carousel-artboard-mismatch`, `carousel-anchor-drift`, `carousel-counter`, `carousel-font-drift`      |

Rapor `studio.lint/1` şemasındadır (`LintReportSchema`): `ok`, `summary`, sıralı `issues`
(kural, önem, katman, mesaj, veri), katman ölçüleri ve süreler. `config.rules` ile bir kuralın
önemi değiştirilebilir ya da kapatılabilir. Denemedeki her kural kimliği korunmuştur
(`css-unreadable` hariç: CSS artık statik okunuyor, bu hata oluşamaz).

## Kurulum ve testler

```sh
pnpm install
pnpm --filter @studio/design-kit typecheck   # izomorfik kaynaklar @types/node olmadan ayrıca denetlenir
pnpm --filter @studio/design-kit test        # renderer testleri dahil (Chromium gerekir)
pnpm --filter @studio/design-kit sync:contract   # DESIGN_CONTRACT.v1.md düzenlendikten sonra
```

- Chromium: Playwright 1.65.1'in Chromium 159'u (`chromium-headless-shell` revizyon 1255) bu Mac'te
  kurulu. Başka makinede: `pnpm --filter @studio/design-kit exec playwright-core install chromium-headless-shell`.
- Chromium başlatılamıyorsa renderer testleri kendiliğinden atlanır; `STUDIO_SKIP_RENDER=1` ile
  zorla atlanır.
- Test fikstürleri `test/fixtures/` altında: denemenin son çıktıları, iyi/kötü fikstürleri ve geçici
  Venta marka dosyaları (fontlar OFL lisanslı). Renderer testleri denemenin kendi PNG'leriyle piksel
  karşılaştırması da yapar (`spikes/design-render/out` varsa).

## Kasıtlı olarak dahil olmayanlar

- Model çağrısı, prompt şablonları, eleştiri döngüsü: F1-3 (worker). Bu paket yalnızca metinleri ve
  denetim çıktısını verir.
- R2 varlık çözücüsü: arayüz (`AssetResolver`) hazır, uygulaması worker'da yazılacak.
- Editör arayüzü (seçim tutamaçları, panel): Faz 2. Burada yalnızca model, işlemler ve önizleme.
- Katmanı başka bir gruba taşıma (yeniden ebeveynleme): `moveLayer` aynı kap içinde sıralar.
- Vektör PDF: PDF sayfaları 2x JPEG'dir (ekrandakiyle birebir, belirlenimci). Seçilebilir metin yok.
- Font alt kümeleme, logo vektörleri, görsel kırpmanın piksele işlenmesi, P3 → sRGB dönüşümü.
- Görsel içeriğin analizi: boşluk ve logo boşluğu denetimleri kutulara bakar; fotoğrafın içinde
  nerede boşluk olduğunu bilmez.

## Bilinen sınırlar

- `large-void` eşikleri (güvenli alanın %24'ü, iki kenarı da %30) denemenin çıktılarıyla ayarlandı;
  carousel kapağındaki boşluğu yakalar, diğer beş çıktıda sessiz. Marka bazında ayarlanabilir.
- Editör iframe'inde piksel kontrastı yok (ekran görüntüsü alınamıyor); kesin sonuç Mac render'ında.
- Story/Reels güvenli alanları resmi değil, sektör kılavuzu (`verified: false`). LinkedIn sınırları
  da doğrulanmadı.
- `zod` kök içe aktarımı yerel ayar dosyalarını da pakete taşıyor (esbuild ölçümü: tüm giriş 183 KB
  gzip). `@studio/contract` da aynı şekilde içe aktardığı için web paketinde paylaşılır.
