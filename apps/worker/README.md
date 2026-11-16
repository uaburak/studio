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
yine de gelirse iş `unsupported job type: …` hatasıyla başarısız olur. Şu an yalnızca `demo.echo` var
(`delayMs` ve `steps` ile yavaş iş taklidi yapar); gerçek üretim handler'ları F1-3 / F1-4'te gelecek.

## Dosyalar

| Dosya               | Görev                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `src/main.ts`       | Giriş noktası, ayarlar, sinyaller ve düzgün kapanış                                      |
| `src/worker.ts`     | Kayıt defteri + runner + bağlantıyı birbirine bağlar                                     |
| `src/connection.ts` | WebSocket, `Authorization` başlığı, `hello`, ping, üstel geri çekilmeli yeniden bağlanma |
| `src/runner.ts`     | Ack, handler çalıştırma, ilerleme, heartbeat, iptal, outbox, release                     |
| `src/registry.ts`   | Tür → handler kayıt defteri, `JobContext`, `RetryableError`                              |
| `src/outbox.ts`     | Onay bekleyen sonuçlar (bellek ve dosya)                                                 |
| `scripts/smoke.ts`  | Çalışan API'ye karşı uçtan uca kontrol                                                   |

Testler (`pnpm --filter @studio/worker test`) sahte soket ile çalışır: kayıt defteri, ack/ilerleme/sonuç sırası,
iptal, kapasite, düzgün kapanış, heartbeat ve ack gelmeyen sonucun yeniden gönderilmesi, bağlantı koptuğunda
üretilen sonucun yeniden bağlanınca gönderilmesi, dosya outbox'ının yeniden başlatmada korunması.
