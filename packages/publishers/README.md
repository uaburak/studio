# @studio/publishers

Onaylanan içeriği Meta Graph API üzerinden **Instagram** ve **Facebook Sayfası**'na yayınlayan kütüphane.

- Çalışma ortamından bağımsızdır: yalnızca `fetch` ve Web API'leri (Request, Response, ReadableStream, Blob, FormData, `crypto.subtle`, `structuredClone`). Node'a özgü hiçbir şey kullanmaz; testler hem Node'da hem **workerd**'de (Cloudflare Workers çalışma ortamı) koşar.
- Graph API sürümü: **v27.0** (2026-11-04'te yayınlandı; `GRAPH_API_VERSION`).
- Kurulum türü: **Instagram API with Facebook Login** (`graph.facebook.com`). Instagram Login (`graph.instagram.com`) desteklenmez.
- Gerçek ağ çağrısı yapan test yoktur; her şey bellek içi sahte Graph API'ye (`@studio/publishers/testing`) karşı test edilir.

## Desteklenen içerik

| İstek (`kind`)         | Akış                                                                                            | Medya                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `instagram.image`      | konteyner → durum yoklama → `media_publish`                                                     | JPEG, herkese açık URL                                |
| `instagram.carousel`   | her öğe için konteyner → `CAROUSEL` konteyneri → yayın                                          | 2–20 öğe; görsel (URL) ve video (URL ya da bayt)      |
| `instagram.reel`       | `REELS` konteyneri → (bayt ise rupload) → yoklama → yayın                                       | MP4/MOV; URL ya da bayt (devam ettirilebilir yükleme) |
| `instagram.story`      | `STORIES` konteyneri → yoklama → yayın                                                          | JPEG ya da video                                      |
| `facebook.photo`       | `POST /{page}/photos`                                                                           | JPEG, PNG, GIF, BMP, TIFF; URL                        |
| `facebook.multi_photo` | yayınlanmamış fotoğraflar (`published=false`) → `POST /{page}/feed` + `attached_media[i]`       | en az 2 görsel                                        |
| `facebook.video`       | URL: `file_url`; bayt: `upload_phase=start/transfer/finish` (parça parça)                       | MP4 önerilir                                          |
| `facebook.reel`        | `video_reels` start → rupload → finish (`video_state=PUBLISHED`) → yoklama                      | 3–90 sn, 9:16                                         |
| `facebook.story`       | fotoğraf: yayınlanmamış foto → `photo_stories`; video: `video_stories` start → rupload → finish | foto ya da 3–60 sn video                              |

Desteklenen ek alanlar: `alt_text` (IG görsel/carousel görseli), `alt_text_custom` (FB foto), `collaborators` (en fazla 3), `user_tags`, `location_id`, `cover_url` / `thumb_offset`, `share_to_feed`, `audio_name`, deneme Reels'i (`trial_params.graduation_strategy`), `is_ai_generated` (IG; carousel'de yalnızca üst konteynerde; FB Reels ve video story).

Sonuç (`PublishResult`): `externalId` (IG medya kimliği; FB foto/video/gönderi kimliği), `postId` (FB gönderi kimliği), `permalink`, `warnings`, `reconciled` (çökme sonrası kurtarıldıysa `true`) ve Instagram için `quota`.

## API'yle yapılamayanlar

- **Story çıkartmaları ve bağlantıları**: anket, soru, bağlantı, müzik, konum çıkartması API'de yok. Story yalnızca medya olarak paylaşılır; açıklama da yoktur.
- **Lisanslı müzik**: Instagram'da yalnızca Audio API (Facebook Login, 2026-06'dan beri) ile; bu pakette henüz yok. Diğer durumlarda ses videonun içine gömülü olmalı.
- **Yayından sonra düzenleme**: bu paket düzenleme yapmaz. Instagram'da açıklama değiştirmek ayrı bir uç gerektirir; görsel/video hiçbir yolla değiştirilemez.
- **Instagram'da yerel zamanlama yok**: zamanlamayı bizim zamanlayıcımız yapar. Konteynerler 24 saatte süresi dolduğu için yayın anında oluşturulur. (Facebook'ta yerel zamanlama var ama tek zamanlayıcı kararı gereği kullanılmıyor.)
- **Instagram'a doğrudan görsel yükleme yok**: görseller herkese açık bir URL'den çekilir (R2 genel URL'si ya da imzalı URL). Video ise bayt olarak itilebilir (rupload).
- Instagram'da alışveriş etiketleri ve filtreler, Reels'in carousel içinde kullanılması, Story'de `alt_text` / ortak hesap desteklenmez.

## Gerekli izinler (Facebook Login)

| Akış             | İzinler                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instagram        | `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`                                                                                                                                                                                |
| Facebook Sayfası | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`                                                                                                                                                                                                          |
| Duruma göre      | `business_management` (işletme portföyü / sistem kullanıcısı), `ads_management` ya da `ads_read` (kullanıcının Sayfada Business Manager rolü varsa, IG yayını için), `publish_video` (bir Meta sayfası "yalnızca video için" diyor; Reels/video kılavuzları listelemiyor) |

Sabitler: `INSTAGRAM_PUBLISH_SCOPES`, `FACEBOOK_PUBLISH_SCOPES`, `SITUATIONAL_SCOPES`. Kullanıcının Sayfada `CREATE_CONTENT` ya da `MANAGE` görevi olmalı. Sayfa Yayın Yetkilendirmesi (PPA) ya da iki adımlı doğrulama isteyen Sayfalarda bunlar tamamlanmadan yayın başarısız olur.

Token'lar: Instagram akışları kullanıcı token'ı (bağlı Sayfanın token'ı da çalışır), Facebook akışları **Sayfa token'ı** ister. Token durumda saklanmaz; her adımda `StepContext.accessToken` ile verilir, `Authorization: OAuth …` başlığında gider (URL'ye hiç yazılmaz) ve tüm hata/log metinlerinden silinir.

## Hesap yardımcıları

- `listManagedPages(graph, userToken)`: `/me/accounts` (sayfalamalı) → Sayfa kimliği, adı, Sayfa token'ı, görevler, `canPublish`, bağlı Instagram hesabı.
- `exchangeForLongLivedUserToken(graph, { appId, appSecret, shortLivedToken })`: ~60 günlük kullanıcı token'ı. Uzun ömürlü kullanıcı token'ıyla alınan Sayfa token'larının süresi dolmaz (ama iptal edilebilir).
- `inspectToken(graph, { inputToken, appAccessToken })`: `debug_token`.
- `classifyTokenHealth(info, { requiredScopes, now, targetId? })` → `valid | expiring_soon | invalid | missing_scopes`. Token süresi ile 90 günlük veri erişimi süresinin (`data_access_expires_at`) erken olanına bakar; varsayılan uyarı eşiği 7 gün.
- "Require App Secret" açıksa `GraphClient`'a `appSecret` verin; her çağrıya `appsecret_proof` eklenir.

## Ön denetim

`validateRequest(request)` her sorunu sabit bir makine kodu, Türkçe mesaj ve alan yoluyla döner (`errors` yayını engeller, `warnings` engellemez). `start()` hata varsa `VALIDATION_FAILED` fırlatır. Sınırlar ve kaynakları `src/validation/rules.ts` içinde:

- Instagram görsel: yalnızca JPEG, en fazla 8 MB, oran 4:5–1,91:1 (genişlik 320–1440 dışıysa yalnızca uyarı: Meta ölçekler).
- Açıklama: 2.200 karakter (emoji 1 sayılır), 30 hashtag, 20 @. Alternatif metin 1.000 karakter.
- Carousel: 2–20 öğe; oranı ilk öğeden farklı öğeler için uyarı.
- Reels: MP4/MOV, 3 sn–15 dk, 300 MB, 23–60 fps, en fazla 1920 piksel genişlik; kapak JPEG.
- IG Story video: 3–60 sn, 100 MB. IG Story görsel: JPEG, 8 MB; 9:16 değilse uyarı.
- Facebook foto: JPEG/PNG/GIF/BMP/TIFF, 10 MB; 1 MB üstü PNG için uyarı. Reels 3–90 sn, en az 540x960, 24–60 fps. Story video 3–60 sn.
- Meta bilgisi (boyut, süre, çözünürlük) verilmezse ilgili kural "denetlenemedi" uyarısıyla geçilir.

## Zamanlayıcı bu durum makinelerini nasıl sürmeli

Her yayın, JSON olarak saklanabilen bir **durum** nesnesidir. Bir adım en fazla bir değiştirici Graph çağrısı yapar ve yeni bir durum döner (girdi asla değiştirilmez):

```ts
import { createPublisher } from "@studio/publishers";

const publisher = createPublisher({ appSecret: env.META_APP_SECRET }); // fetch/clock/sleep isteğe bağlı

// 1) Onay anında (ya da zamanı gelince): doğrula ve ilk durumu kaydet.
const state = publisher.start(request); // VALIDATION_FAILED fırlatabilir
await db.saveState(scheduleId, state);

// 2) Her tetiklemede tek adım at, SONUCA GÖRE DAVRANMADAN ÖNCE durumu kaydet.
const out = await publisher.step(state, { accessToken, media: r2Reader });
await db.saveState(scheduleId, out.state);
switch (out.status) {
  case "continue":
    /* hemen bir sonraki adım */ break;
  case "wait":
    /* out.resumeAt (epoch ms) anında yeniden tetikle */ break;
  case "done":
    /* out.result: externalId, permalink, warnings → yayın kaydı */ break;
  case "failed":
    // out.error: { code, message (TR), action, retryable, retryAfterMs, graph }
    // action: retry | reauth | fix_content | wait_quota | manual_check
    // retryable ise aynı durum daha sonra yeniden adımlanabilir (ör. hesap yeniden bağlanınca).
    break;
}
```

Kurallar:

- **Kaydet, sonra davran.** Workflow her adımın sonucunu kalıcı hale getirmeden bir sonraki adıma geçmemeli. Cloudflare Workflows'ta her `step.do` tek bir `publisher.step` çağrısı olabilir; `wait` için `step.sleepUntil(resumeAt)`.
- **Çökme sonrası devam.** Son kaydedilen durumla `step` yeniden çağrılır. Yayın adımı önce platforma bakar: Instagram'da konteyner `PUBLISHED` ise yeniden yayınlamaz, medya kimliğini son gönderiler arasından bulur; Facebook'ta Sayfa gönderilerinde ek kimliği / aynı metin, video durumu (`publishing_phase`) ya da story listesi kontrol edilir. Kesin karar verilemezse `PUBLISH_UNCERTAIN` (elle kontrol) döner; asla tahminle ikinci kez paylaşılmaz.
- **Yoklama**: Meta'nın önerisi dakikada bir, en fazla 5 dakika (`pollIntervalMs`, `pollTimeoutMs`). Süre dolarsa `PROCESSING_TIMEOUT` döner ama faz korunur; sonra yeniden adımlanabilir. Uzun Reels için bu süreyi büyütmek gerekebilir.
- **Geçici hatalar**: istemci kısa beklemeleri kendi içinde üstel geri çekilmeyle yeniden dener (yalnızca tekrarı zararsız çağrılarda; yayın çağrıları yalnızca hız sınırında yeniden denenir). Uzun beklemeler (`estimated_time_to_regain_access`, ör. 30 dk) `wait` olarak zamanlayıcıya döner.
- **Kota**: Instagram'da `content_publishing_limit` başta ve yayından hemen önce okunur; dolu ise `QUOTA_EXCEEDED` (`wait_quota`). Facebook Reels için Sayfa başına 24 saatte 30 API yayını sınırı var; okunacak bir uç olmadığı için zamanlayıcı kendi tarafında saymalı.
- **Bayt yüklemeleri**: `{ source: { type: "upload", key } }` videolar için `StepContext.media` (`MediaReader`) verilmeli; R2 ile `bucket.get(key, { range: { offset, length } }).body`. Yükleme yarıda kalırsa bir sonraki adım Meta'dan alınan bayt sayısını sorar ve oradan devam eder.
- Konteyner `EXPIRED` ya da yeniden denenebilir bir hatayla `ERROR` olursa bir kez yeniden oluşturulur (`maxRecreations`).
- `runToCompletion(publisher, state, ctx, { clock, sleep, onState })` Mac worker, betik ve testler içindir; Workers'ta isteği uyutmayın.

## Test

```sh
pnpm --filter @studio/publishers test          # Node + workerd
pnpm --filter @studio/publishers test:node
pnpm --filter @studio/publishers test:workerd
```

`@studio/publishers/testing`: `FakeGraph` (bellek içi `fetch`), `FakeClock`, `createFakeEnv`, `memoryMediaReader`. Sahte sunucu konteyner durumlarını, süre dolumunu, kotayı, `config_issue` kısmi başarısını, hız sınırlarını, geçici hataları, kaybolan yanıtları (`dropResponse`: sunucu işlemi yapar, bağlantı kopar) ve yarıda kalan yüklemeleri modeller; aynı şeyi iki kez yayınlama girişimlerini `stats.duplicatePublishAttempts` ile sayar. Zamanlayıcı testleri de bunu kullanabilir.

## Gerçek Meta uygulamasıyla doğrulanması gerekenler

- `Authorization: OAuth` başlığının tüm `graph.facebook.com` uçlarında kabul edilmesi (belgelerde rupload ve konteyner durumu için örnek var).
- rupload'a parça parça yükleme (`uploadChunkBytes`; varsayılan kapalı, belgelenmemiş) ve akış gövdesinin Workers'tan `Content-Length` ile gitmesi.
- Instagram konteyner `status` metnindeki hata alt kodu biçimi; `video_status.uploading_phase.bytes_transferred` alanının gerçek davranışı.
- Facebook kurtarma eşleştirmesi: `published_posts` içindeki `attachments{target, subattachments}` alanları, `/{page}/videos` ve `/{page}/stories` filtreleri.
- Facebook parçalı video yüklemesinde aynı parçanın yeniden gönderilmesinin kabul edilmesi.
- Reels/video story `finish` sonrasında `publishing_phase` değerlerinin geçişi; Reels yanıtında gönderi kimliği gelmediği için `externalId` video kimliğidir.
- Geliştirme modundaki uygulamanın paylaşımlarının herkese görünürlüğü (PLAN T4).
