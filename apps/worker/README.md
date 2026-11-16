# @studio/worker — Mac worker

Mac'te çalışan Node süreci. Buluttaki hub'a (Durable Object) **dışarıya doğru** WebSocket ile bağlanır,
kendisine gönderilen işleri çalıştırır, ilerlemeyi ve sonucu geri bildirir. Mac kapalı ya da uykudaysa
işler D1'de `queued` olarak bekler; worker bağlanınca dağıtılır.

## Yerelde çalıştırma

```sh
# 1) API tarafı: gizli anahtar ve migration (bir kez)
cp apps/api/.dev.vars.example apps/api/.dev.vars      # WORKER_TOKEN değerini değiştirin
pnpm --filter @studio/api db:migrate

# 2) Worker tarafı: aynı anahtar
cp apps/worker/.env.example apps/worker/.env          # STUDIO_WORKER_TOKEN = WORKER_TOKEN

# 3) İki ayrı terminal
pnpm dev          # API http://127.0.0.1:8787 (+ web)
pnpm dev:worker   # worker, ws://127.0.0.1:8787/api/hub adresine bağlanır

# Uçtan uca kontrol (API çalışırken)
pnpm --filter @studio/worker smoke
```

Bir iş oluşturup izlemek:

```sh
curl -s -X POST localhost:8787/api/jobs -H 'content-type: application/json' \
  -d '{"type":"demo.echo","payload":{"text":"merhaba","delayMs":20000,"steps":5}}'
curl -s localhost:8787/api/jobs/<id>                 # durum, ilerleme, deneme sayısı
curl -s -X POST localhost:8787/api/jobs/<id>/cancel  # iptal
curl -s localhost:8787/api/workers/presence          # Mac çevrimiçi mi?
```

Ayarların tamamı ve varsayılanlar: `.env.example`. Yalnızca `STUDIO_WORKER_TOKEN` zorunludur; yoksa worker
başlamaz. Gerçek değerler hiçbir zaman depoya girmez.

## Gerçek üretim: başsız Claude (A4)

Worker iki gerçek iş çalıştırır; ikisi de Mac'teki `claude` komut satırını **sahibin aboneliğiyle** çağırır:

| İş türü            | Ne yapar                                                                                                                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.turn`        | Sohbet turu: bağlamı alır (marka, onaylı profil, son mesajlar, takma adlar), son mesajda eklenen/anılan görselleri modele gösterir, yanıtı **yazıldıkça** sohbete akıtır; içerik istenmişse planı (`PUT plan`) önerir, bilgi eksikse soru parçası ekler.                |
| `content.generate` | Plan kalemi (ya da doğrudan içerik) için tasarım: Claude HTML yazar → temizlenir → Chromium render + denetim → ekran görüntüsü ve denetim raporuyla bir eleştiri/düzeltme geçişi → (hata kaldıysa) bir düzeltme geçişi → JPEG'ler yüklenir → `generated` içerik sürümü. |

### Bir kez: oturum

```sh
claude auth login                     # tarayıcıda abonelik hesabıyla giriş
claude auth status                    # "loggedIn": true olmalı
pnpm --filter @studio/worker selftest # sürüm + oturum + küçük bir deneme çağrısı; 0 = kullanılabilir
```

Ayrı bir oturum istenirse: `CLAUDE_CONFIG_DIR=~/.studio/claude claude auth login` ve `.env` içinde
`STUDIO_CLAUDE_CONFIG_DIR=~/.studio/claude`. Uzun ömürlü token: `claude setup-token`, sonra worker'ın ortamında
`CLAUDE_CODE_OAUTH_TOKEN`. **Worker'a asla `ANTHROPIC_API_KEY` verilmez**; verilse de çocuk sürece geçmez.

### Çalıştırma

```sh
pnpm dev:worker      # geliştirme (tsx watch, apps/worker/.env okunur)
pnpm --filter @studio/worker build && pnpm --filter @studio/worker start   # paketlenmiş
```

Açılışta worker önce öz sınamayı yapar (`claude --version`, `claude auth status`, gerekirse küçük bir çağrı),
sonra hub'a bağlanır. Sonuç `hello`'yu belirler:

- **oturum açık** (`ok`) ya da **kullanım sınırı dolu** (`limited`): `chat.turn` ve `content.generate` duyurulur.
- **oturum yok / süresi doldu** ya da `claude` çalışmıyor: bu türler **duyurulmaz**; işler hub kuyruğunda bekler
  (kaybolmaz), presence'ta worker sürümü `0.1.0+claude.unauthenticated` görünür. Worker 5 dakikada bir yeniden
  dener; oturum gelince yeniden bağlanıp türleri duyurur. Bir iş sırasında oturum düşerse aynısı olur.
- Küçük deneme çağrısı en fazla 6 saatte bir yapılır (`~/.studio/worker/claude-health.json`); `tsx watch`
  yeniden başlatmaları abonelikten yemez. `STUDIO_CLAUDE_SELFTEST=never|always` ile değiştirilir.

### Başsız çağrı tarifi (`src/claude/`)

- Ortam izin listesi: `HOME PATH USER LOGNAME TMPDIR LANG` (+ ayarlıysa `CLAUDE_CONFIG_DIR`,
  `CLAUDE_CODE_OAUTH_TOKEN`). `ANTHROPIC_*` ve üst oturumun `CLAUDE_CODE_*` değişkenleri geçmez. `--bare` yok.
- Bayraklar: `-p --input-format stream-json --output-format stream-json --verbose --system-prompt-file F
  --tools "" --setting-sources "" --strict-mcp-config --disable-slash-commands --no-session-persistence
  --permission-mode dontAsk --permission-prompts none --json-schema S --model M --effort E`
  (+ sohbette `--include-partial-messages`). **Hiçbir araç verilmez** (A3: Read klasör dışına çıkabildi).
- Görseller stdin mesajında base64 blok; uzun kenar 1568 px'e küçültülür. Sonuç son `result` satırından okunur
  (`structured_output`, `usage`, `total_cost_usd` — abonelikte fatura değil, liste fiyatı tahmini).
- Akış: yapılandırılmış çıktı `StructuredOutput` aracının `input_json_delta` parçalarıyla gelir; `reply`
  alanı parça parça çözülüp ~250 ms'de bir `text.delta` olarak yazılır.
- Sınanan CLI: **2.1.292** (Claude Code). Model/efor: tur ya da iş `model` (`opus|sonnet|haiku`) ve `effort`
  (`low|medium|high|xhigh`) taşıyorsa onlar, yoksa `STUDIO_CLAUDE_MODEL` / `STUDIO_CLAUDE_EFFORT_*`, yoksa
  `opus` / `medium`. Kullanılan model kimliği turun `model` alanına ve `usage.model`'e yazılır.

### Sınırlar ve kuyruk

- **Aynı anda tek Claude çağrısı** (`STUDIO_CLAUDE_CONCURRENCY`, varsayılan 1); fazlası sırayla bekler.
  Hub da `STUDIO_CONCURRENCY` (varsayılan 1) kadar iş gönderir; gerisi hub kuyruğundadır.
- **5 saatlik kullanım sınırı:** çağrı sınır hatası verirse iş **başarısız olmaz, bekletilir**: tüm çağrılar
  sıfırlanma saatine (+1 dk) kadar durur, sonra aynı çağrı yeniden yapılır. Sıfırlanma saati CLI'nin
  `rate_limit_event`'inden, yoksa mesajdan (`resets 7pm`, `…|<unix>`), o da yoksa 30 dk sonrası
  (`STUDIO_USAGE_LIMIT_FALLBACK_MIN`). Bekleme sırasında: sohbette asistan mesajında "Claude kullanım sınırı
  doldu — HH:MM civarında devam edecek" ilerleme adımı, işte `progressMessage`; heartbeat kiralamayı korur.
  İptal edilirse bekleme hemen biter.
- **Kullanım bildirimi (`worker.usage`):** her çağrının akışındaki `rate_limit_event`
  (`unifiedWindows.five_hour` / `seven_day`: `utilization` 0..1 ve `resetsAt`) her çağrıdan sonra ve her
  bağlanışta hub'a gönderilir (5 saatlik ve haftalık pencere: kullanılan yüzde, sıfırlanma, sınırda mı).
  Son değer `~/.studio/worker/claude-usage.json`'da saklanır; yalnızca kullanım okumak için **çağrı yapılmaz**.
- Geçici hatalar (aşırı yük, 5xx, ağ) 3 kez artan aralıkla yeniden denenir; zaman aşımı (`STUDIO_CLAUDE_TIMEOUT_S`,
  900 sn) ve geçici hatalar işi `retryable` bitirir (hub deneme hakkı varsa yeniden kuyruğa koyar).

### Ölçümler (bu Mac, 2026-11-16, uçtan uca çalıştırma, CLI varsayılan eforu)

| Ne                                    | Süre                        | Claude çağrısı             | Çıktı token | Önbellek (yazma / okuma) | Liste fiyatı tahmini |
| ------------------------------------- | --------------------------- | -------------------------- | ----------- | ------------------------ | -------------------- |
| Öz sınama (küçük çağrı)               | ~4 sn                       | 1                          | ~20         | ~1,2 K / 0               | ~$0,01               |
| Sohbet turu (plan, 7 kalem, 1 görsel) | 41,6 sn (ilk delta 18,1 sn) | 1                          | 3 764       | 6,7 K / 3,4 K            | $0,13                |
| Post, 1 slayt, @image dolu yuvada     | 184 sn                      | 2 (üret + eleştiri/düzelt) | 16 691      | 45 K / 0                 | $0,70                |
| Carousel, 4 slayt                     | 350 sn                      | 2                          | 40 163      | 59 K / 0                 | $1,27                |
| Carousel, 5 slayt                     | 402 sn                      | 2                          | 46 664      | 64 K / 0                 | $1,45                |

- Render + denetim: slayt başına ~0,4–0,6 sn (Chromium). Üç post da ilk geçişte 0 hata verdi; düzeltme
  geçişine gerek olmadı. 5 saatlik pencere bu çalıştırma boyunca %81'den %90'a çıktı (aynı anda başka ajanlar da
  çalışıyordu; tamamı bu işe ait değil).
- Bu ölçümde tasarım çağrıları önbellekten okumadı: üretim ve eleştiri geçişlerinin JSON şeması farklıydı ve
  araç tanımı önbellek önekinin parçası. Şema artık tüm geçişlerde aynı (yaklaşık 20 K tokenlik sistem promptu
  ikinci geçişte önbellekten okunmalı); bu değişiklik gerçek çağrıyla ölçülmedi.
- Varsayılan efor artık `medium`; yukarıdaki ölçüm CLI'nin kendi varsayılan eforuyla yapıldı.

### Marka profili, dosyalar ve gerçekler

- `brand.css` onaylı profilin `tokens`'ından design-kit ile üretilir. Font/logo/marka görseli dosyaları
  **`tokens.fileAssets`** ile bulunur: `{ "fonts/x.woff2": "<assetId>", "logos/y.png": "<assetId>" }`
  (dosyalar markanın varlıkları olarak yüklenir; worker indirir ve `~/.studio/worker/cache/assets`'te tutar).
- Gerçekler (FACTS) **`tokens.facts`** içindedir (`allowedNumbers`, ifadeler, yasak iddialar). Tasarımdaki ve
  açıklamadaki her rakam `allowedNumbers` ile denetlenir (`unverified-number`), carousel sayaçları hariç.
- `tokens.status` `provisional` ise profil "geçici" olarak etiketlenir (yanıtta ve sürüm notunda).
- **Onaylı profil yoksa** nötr varsayılan kullanılır (Helvetica Neue, tek vurgu rengi, logo yok, hiç gerçek yok)
  ve sürüm notunda/yanıtta açıkça söylenir. Bu iki anahtar sözleşmeye taşınana kadar geçici bir dikiştir.

### Görseller ve @takma adlar

- Sohbet turu yalnızca **son kullanıcı mesajında eklenen ya da anılan** görselleri görür (en fazla 4).
- Kullanıcı bir post için görsel isterse ("ürün postunda @image kullan") plan kalemine `imageSlot: user_upload`
  ve görsel tarifinin başına `@image` yazılır. `content.generate` bu anmayı konuşmanın takma adlarıyla çözer,
  görseli `/media/<assetId>.png` olarak render'a verir ve tasarımda **dolu** görsel yuvasına koyar. Görseli
  olmayan `user_upload` / `ai_generate` kalemlerinde yuva boş kalır (marka yer tutucusu, denetimde `slot-empty` bilgi).
- Ön ayar: Instagram 4:5 (1080×1350) varsayılan; Facebook/LinkedIn feed ve story ön ayarları platforma göre.

### Sorun giderme

| Belirti                                                                     | Neden / çözüm                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Presence'ta worker var ama `chat.turn` yok, sürüm `+claude.unauthenticated` | `claude auth login`; 5 dk içinde kendiliğinden duyurulur ya da worker'ı yeniden başlatın.                                      |
| Sürüm `+claude.error`                                                       | `claude` bulunamadı / çalışmadı: `which claude`, `STUDIO_CLAUDE_BIN`. `pnpm --filter @studio/worker selftest` çıktısına bakın. |
| Sohbette "Claude kullanım sınırı doldu — HH:MM"                             | Normal: iş bekletiliyor, o saatte devam eder. Beklemek istemiyorsanız turu iptal edin.                                         |
| İş `timeout` ile yeniden kuyruğa döndü                                      | Çok büyük carousel; `STUDIO_CLAUDE_TIMEOUT_S` artırın ya da daha az slayt isteyin.                                             |
| Render'da font yok / `network-request`                                      | Profilin `tokens.fileAssets` eşlemesi eksik ya da varlık silinmiş.                                                             |
| Ham akışı görmek                                                            | `STUDIO_CLAUDE_LOG_STREAMS=1` → `~/.studio/worker/claude-logs/*.stream.jsonl`.                                                 |
| Chromium başlamıyor                                                         | `pnpm --filter @studio/design-kit exec playwright-core install chromium-headless-shell`.                                       |

### Uçtan uca deneme (özel API'ye karşı)

```sh
S=$(mktemp -d)
pnpm --filter @studio/api exec wrangler d1 migrations apply DB --local --persist-to $S/api
pnpm --filter @studio/api exec wrangler dev --port 8797 --ip 127.0.0.1 --persist-to $S/api \
  --inspector-port 9337 --var WORKER_TOKEN:test-token &
STUDIO_E2E_API=http://127.0.0.1:8797 STUDIO_WORKER_TOKEN=test-token STUDIO_E2E_STATE=$S/worker \
  pnpm --filter @studio/worker e2e        # STUDIO_E2E_ITEMS=3; çıktılar docs/e2e/
```

Betik paylaşılan :8787 API'sine karşı çalışmayı reddeder. Son çalıştırmanın çıktıları: [docs/e2e/](docs/e2e/).

## İşin yaşam döngüsü (worker tarafı)

```
hub  job.dispatch {job, attempt} ─►  worker: job.ack  (kiralama başlar)
                                     handler(payload, ctx) çalışır
                                     ctx.progress() ─► job.progress   (kiralamayı uzatır)
                                     her 15 sn      ─► job.heartbeat  (çalışan işlerin listesi)
                                     bitince        ─► job.result     (önce outbox'a yazılır)
hub  job.result.ack ─►               outbox'tan silinir
hub  job.cancel     ─►               ctx.signal iptal edilir ─► job.result {status: cancelled}
```

- **Outbox:** Her sonuç hub `job.result.ack` gönderene kadar `STUDIO_STATE_DIR/outbox.json` dosyasında
  durur (varsayılan `~/.studio/worker`). Bağlantı koparsa yeniden bağlanınca, süreç yeniden başlarsa bir sonraki
  açılışta tekrar gönderilir; ack gelmezse 30 sn'de bir yeniden denenir. Hub ilk sonucu kabul eder,
  tekrarları yalnızca onaylar, böylece sonuç tam bir kez işlenir.
- **Yeniden bağlanma:** `hello` mesajı `activeJobIds` (çalışan + sonucu bekleyen işler) ve `concurrency`
  taşır. Hub listede olmayan ama bu worker'a atanmış işleri hemen kuyruğa geri koyar; listede olup
  kuyruğa dönmüş işleri geri verir (yeniden çalıştırmaz).
- **Aynı işin iki kez gelmesi:** Çalışan bir iş için gelen ikinci `job.dispatch` yalnızca ack'lenir; sonucu
  outbox'ta olan iş için sonuç yeniden gönderilir. Handler iki kez çalışmaz.
- **Kapasite:** `STUDIO_CONCURRENCY` (varsayılan 1). Hub fazlasını göndermez; gönderirse worker işi
  `job.release {reason: "busy"}` ile geri verir.
- **Düzgün kapanış (SIGINT/SIGTERM):** worker `worker.drain` gönderir (hub ona yeni iş vermez), çalışan
  işlerin sinyalini iptal eder ve her birini `job.release` ile geri verir (deneme hakkı yanmaz), gönderilmemiş
  sonuçlar için `STUDIO_SHUTDOWN_TIMEOUT_S` kadar bekler, sonra çıkar. İkinci sinyal hemen çıkar.
  `kill -9` ya da Mac'in uyuması gibi düzensiz bir kopuşta iş, hub'daki kiralama dolunca (60 sn) ya da worker
  yeniden bağlandığında kuyruğa döner; bu durumda deneme hakkı sayılır.

## Handler yazmak

```ts
import { z } from "zod";
import { defineHandler, RetryableError } from "../registry.ts";

export const myJob = defineHandler({
  payload: z.object({ brandId: z.string() }), // geçersiz payload handler'a hiç ulaşmaz
  async run(payload, ctx) {
    ctx.log("başladı");
    ctx.progress(0.1, "hazırlanıyor");
    const res = await fetch(url, { signal: ctx.signal }); // iptalde durur
    if (res.status === 429) throw new RetryableError("hız sınırı"); // hub deneme hakkı varsa yeniden kuyruğa koyar
    return { ok: true }; // job.output olarak D1'e yazılır
  },
});
```

`src/worker.ts` içindeki `createDefaultRegistry()` içinde `register("tür", handler)` ile eklenir;
kayıtlı türler hub'a `capabilities` olarak bildirilir ve hub yalnızca bu türleri gönderir. Kayıtlı olmayan bir tür
yine de gelirse iş `unsupported job type: …` hatasıyla başarısız olur. Kayıtlı türler: `demo.echo` (yavaş iş
taklidi), `chat.turn` ve `content.generate` (Claude oturumu varken; aşağıda).

## Dosyalar

| Dosya                                  | Görev                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`                          | Giriş noktası, ayarlar, sinyaller ve düzgün kapanış                                                                                                                       |
| `src/worker.ts`                        | Kayıt defteri + runner + bağlantıyı birbirine bağlar                                                                                                                      |
| `src/connection.ts`                    | WebSocket, `Authorization` başlığı, `hello`, ping, üstel geri çekilmeli yeniden bağlanma                                                                                  |
| `src/runner.ts`                        | Ack, handler çalıştırma, ilerleme, heartbeat, iptal, outbox, release                                                                                                      |
| `src/registry.ts`                      | Tür → handler kayıt defteri, `JobContext`, `RetryableError`                                                                                                               |
| `src/outbox.ts`                        | Onay bekleyen sonuçlar (bellek ve dosya)                                                                                                                                  |
| `scripts/smoke.ts`                     | Çalışan API'ye karşı uçtan uca kontrol (`demo.echo`)                                                                                                                      |
| `scripts/e2e.ts`                       | Gerçek Claude ile uçtan uca kabul denemesi (özel API'ye karşı)                                                                                                            |
| `scripts/selftest.ts`                  | Claude öz sınaması                                                                                                                                                        |
| `src/agent.ts`, `src/agent-runtime.ts` | Claude ayarları; API istemcisi, kapı, sağlık durumu, renderer, kayıt                                                                                                      |
| `src/claude/`                          | Başsız çağrı: `runner` (spawn, akış, iptal, zaman aşımı), `gate` (sıra, sınırda bekleme), `limits` (hata sınıfları), `health` (öz sınama), `usage` (pencereler), `models` |
| `src/chat/`                            | `chat.turn`: `turn` (handler), `prompt` (sistem promptu + bağlam), `schema` (JSON şeması, plan dönüşümü), `images`, `writer` (deltalar, parçalar)                         |
| `src/generate/`                        | `content.generate`: `handler`, `pipeline` (üret → render+denetim → eleştiri → düzelt), `prompt`, `schema`, `brand` (brand.css, gerçekler, nötr profil, dosya çözücü)      |
| `src/usage-report.ts`                  | `worker.usage` çerçevesi (sözleşme biliyorsa gönderilir)                                                                                                                  |

Testler (`pnpm --filter @studio/worker test`) sahte soket ile çalışır: kayıt defteri, ack/ilerleme/sonuç sırası,
iptal, kapasite, düzgün kapanış, heartbeat ve ack gelmeyen sonucun yeniden gönderilmesi, bağlantı koptuğunda
üretilen sonucun yeniden bağlanınca gönderilmesi, dosya outbox'ının yeniden başlatmada korunması.

Claude tarafının testleri gerçek çağrı yapmaz: `test/fixtures/fake-claude.mjs` sahte bir `claude` ikilisidir
(argümanları, ortamı ve stdin'i kaydeder, verilen stream-json satırlarını basar). Kapsam: bu Mac'te bir gerçek
çağrıdan kaydedilmiş akış (`test/fixtures/real-structured-stream.jsonl`, yollar temizlendi), kullanım sınırı
(olaydan ve yalnızca metinden sıfırlanma saati), oturum hatası, bozuk/eksik çıktı, sonuçsuz çökme, eksik ikili,
zaman aşımı, iptal; ortam izin listesi ve bayraklar; kapı (sıra, sınırda bekleme ve devam, geçici hata
denemeleri, bekleme sırasında iptal); öz sınama ve önbelleği; duyurulan türler ve `worker.usage`; sohbet
turu (akış sırası, plan, soru, markasız konuşma, sınırda bekleme parçası, hata, iptal, model/efor seçimi);
görsel seçimi; plan dönüşümü; `content.generate` (sahte renderer ile akış, düzeltme geçişi, aynı işin
tekrarında sürümün yeniden kullanılması, Reels reddi) ve Chromium varsa gerçek render.
