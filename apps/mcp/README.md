# Studio MCP sunucusu (`@studio/mcp`)

Claude Code'un (ve ileride başka ajanların) Studio'da uygulamanın yapabildiği her şeyi
yapabilmesi için MCP sunucusu. Mac'te çalışan yerel API'yi (`http://127.0.0.1:8790`) **sahip**
olarak kullanır; kendi başına veri tutmaz.

- **Yalnızca stdio**: ağda dinlemez. İstemci (Claude Code) süreci başlatır, stdin / stdout'tan konuşur.
- **Yalnızca bu Mac**: API adresi `127.0.0.1` / `localhost` / `[::1]` dışına çıkamaz. Adres
  `STUDIO_API_URL` ile değiştirilebilir ama yine yalnızca loopback; başka bir adres verilirse sunucu
  başlamaz. Verilmezse port, çalışan uygulamanın yazdığı `host.json`'dan okunur (yoksa 8790).
- **Sahip anahtarı**: `~/Library/Application Support/Studio/owner-secret` her çağrıda dosyadan
  okunur ve yalnızca `X-Studio-Owner` başlığına konur. Loglanmaz, yazdırılmaz, araç sonucunda
  dönmez (sunucu yanıtlarında geçse bile `[gizli]` olur), saklanmaz, araç argümanı olarak alınmaz.
- Studio açık değilse araçlar şunu söyler: _"Studio açık değil: Mac uygulamasını başlatın."_

## Çalıştırma

Node 24 TypeScript'i doğrudan çalıştırır; derleme gerekmez:

```sh
node apps/mcp/src/main.ts          # depodan (Claude Code bunu kullanır)
pnpm -C apps/mcp build             # dist/main.js (esbuild, bağımlılıklar node_modules'ten)
pnpm -C apps/mcp start             # node dist/main.js
pnpm -C apps/mcp test              # vitest (sahte API ile; gerçek uygulamaya dokunmaz)
```

### Claude Code

Depo kökündeki `.mcp.json` sunucuyu `studio` adıyla proje kapsamında kaydeder:

```json
{
  "mcpServers": {
    "studio": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/apps/mcp/src/main.ts"]
    }
  }
}
```

Depoda Claude Code ilk açılışta bu sunucuyu onaylamanızı ister (`/mcp` ile durumuna bakılır).
Araçlar `mcp__studio__<ad>` olarak görünür. Studio'nun kendi sohbet ajanı (worker) Claude Code'u
`--strict-mcp-config` ile çalıştırdığı için bu dosyayı okumaz.

Elle eklemek (her klasörde geçerli olsun):

```sh
claude mcp add --scope user studio -- node /Users/burak/Desktop/Burak/Code/Studio/apps/mcp/src/main.ts
```

### Claude Desktop ve diğer istemciler

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "studio": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/burak/Desktop/Burak/Code/Studio/apps/mcp/src/main.ts"]
    }
  }
}
```

Masaüstü uygulamaları `PATH`'i kısıtlı başlatır: `node`'un tam yolunu yazın (`which node`).
Stdio MCP destekleyen her istemci (Cursor, Zed, Codex CLI …) aynı komutla çalışır.

Ortam değişkenleri:

| Değişken           | Ne                                                                     |
| ------------------ | ---------------------------------------------------------------------- |
| `STUDIO_API_URL`   | API adresi (yalnızca loopback), ör. `http://127.0.0.1:8790`            |
| `STUDIO_MCP_TOOLS` | `curated`: yalnızca `studio_*` araçları (kısa liste); varsayılan `all` |

## Araçlar

### Özel araçlar (önce bunlar)

| Araç                    | Ne yapar                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `studio_status`         | Studio açık mı, markalar, worker, Claude / Gemini / diğer sağlayıcıların durumu, yapay zekâ harcaması, bütçe |
| `studio_chat`           | Sohbet ajanına sahip olarak mesaj gönderir, tur bitene kadar bekler, yanıt parçalarını döndürür              |
| `studio_chat_wait`      | Süresi dolan bir sohbet turunu beklemeye devam eder                                                          |
| `studio_answer`         | Ajanın sorusunu yanıtlar ya da izin kartına karar verir, sonra turu bekler                                   |
| `studio_wait_job`       | Bir işi bitene kadar izler (ilerleme bildirimiyle)                                                           |
| `studio_brand_overview` | Marka + kit + onaylı profil + ürünler + skill'ler + sosyal hesaplar tek çağrıda                              |
| `studio_upload_file`    | Bu Mac'teki bir dosyayı markanın varlıklarına yükler                                                         |

`studio_chat` ajan izin ya da cevap isterse `state: "waiting_for_owner"` ve `waitingFor` kartlarıyla
döner (`consent` / `question` / `approval_request`). Süre dolarsa `still_running` döner.

### API araçları (OpenAPI'den)

Sunucu açılışta `GET /api/openapi.json`'u okur ve **her API işlemi için bir araç** üretir (~170).
Uygulama kapalıysa depoya işlenmiş `apps/mcp/openapi.json` kopyası kullanılır; uygulama sonra
açılınca liste canlı belgeyle yenilenir.

- **Ad**: `operationId` varsa onun snake_case hâli; yoksa yöntem + yolun sabit parçaları, yol bir
  parametreyle bitiyorsa `by_<param>`: `GET /api/brands/{id}` → `get_brands_by_id`,
  `POST /api/contents/{id}/approve` → `post_contents_approve`.
- **Girdi**: yol ve sorgu parametreleri en üstte, JSON gövde `body` içinde (`$ref`'ler çözülmüş).
  Çok parçalı yüklemede dosya alanı `body.<alan>_path` (yerel dosya yolu) olur.
- **Yanıt**: JSON; 40.000 karakterden uzunsa kesilir, devamı `response_offset` ile okunur (listelerde
  `limit` / `cursor` da var). İkili yanıtlar (asset içeriği, küçük resim) geçici klasöre
  (`$TMPDIR/studio-mcp/`) kaydedilir, yolu döner; 1 MB'tan küçük resimler ayrıca görsel olarak gelir.
- Dışarıda kalanlar: `/api/worker/*` (yalnızca worker), WebSocket akışları, `/api/pairing/claim`.

Alanlara göre (canlı belgeye göre değişebilir): Markalar 24, Marka profilleri 6, İçerikler 17,
Sohbet 13, Sosyal hesaplar 11, Varlıklar 10, Worker / sağlayıcılar 10, Planlar 9, Yorumlar 9,
Yapay zekâ 9, Şablonlar 8, Zamanlamalar 8, Yayın 6, İşler 5, İstatistik 5, Onaylar 5, Cihazlar 5,
Yayın ayrıntıları 4, Planlama 4, Sistem 2, Tahmin 1.

Kopyayı yenilemek (API rotaları değişince, sonra commit):

```sh
pnpm -C apps/mcp openapi:update          # API kaynağından (uygulama gerekmez)
pnpm -C apps/mcp openapi:update --live   # çalışan uygulamadan
```

## Güvenlik kuralları

1. **Okuma serbest** (GET), olağan yazma işlemleri serbest.
2. **Tehlikeli işlemler `confirm: true` ister** (yoksa API'ye hiç gidilmez, ajan neden reddedildiğini
   görür). Ajan bunu yalnızca sahip açıkça istediyse vermelidir. Kapsam (`src/safety.ts`):
   - her `DELETE`, çöpü kalıcı boşaltma (`maintenance/purge`);
   - hesap bağlantısını kesme, token değiştirme, hesap bağlama (Meta / LinkedIn);
   - hemen yayınlama, zamanlama ve zamanlanmışı taşıma, yorumlara yanıt / gizleme / silme;
   - cihaz eşleştirme kodu, cihaz iptali, eşleştirme adresleri;
   - yapay zekâ anahtarları, bulut yayıncı anahtarı, Claude / Codex / Antigravity oturum açma;
   - bütçe ve harcama tercihleri, Claude sınırında Gemini'ye geçme kararı;
   - ücretli ya da toplu üretim: görsel yeniden üretme, plan üretimi, toplu düzeltme / dönüştürme,
     `POST /api/jobs` ile `image.generate`, `content.generate`, `schedule.publish`, `brand.analyze`,
     `brand.skill_draft`;
   - sohbetteki izin kartını **onaylamak** (`studio_answer` / consent `allow: true`); reddetmek serbest.
3. **Gizli değerler maskelenir**: yanıtlardaki `token`, `accessToken`, `apiKey`, `secret`,
   `password`, `privateKey` … alanları ve metindeki `Bearer …`, `sk-…`, `AIza…`, `EAA…` kalıpları
   `[gizli]` olur; sahip anahtarı hiçbir çıktıda görünmez.
4. **Kabuk yok, rastgele adres yok**: sunucu komut çalıştırmaz, yalnızca Studio API'sinin `/api/`
   yollarına gider, yönlendirmeleri izlemez.
5. **Dosya yükleme**: yalnızca ev klasöründeki normal dosyalar (bağlantılar çözülüp hedef denetlenir),
   gizli klasörler (`.ssh`, `.config` …) ve `~/Library` reddedilir, yalnızca Studio'nun kabul ettiği
   medya türleri, en çok 50 MB.
6. **Log**: `~/Library/Application Support/Studio/logs/mcp.log`, her çağrı için yalnızca araç adı,
   sonuç (`ok` / `error` / `refused` / `needs_confirm`) ve süre; argüman ya da gövde yazılmaz.

## Kod

| Dosya               | Ne                                                             |
| ------------------- | -------------------------------------------------------------- |
| `src/main.ts`       | stdio girişi                                                   |
| `src/server.ts`     | MCP sunucusu: araç listesi, çağrı, log, OpenAPI yükleme        |
| `src/spec.ts`       | OpenAPI → araç (ad, şema, `$ref` çözümü)                       |
| `src/operations.ts` | Üretilen aracı çalıştırma (onay kapısı, URL, gövde, multipart) |
| `src/curated.ts`    | `studio_*` araçları                                            |
| `src/client.ts`     | Loopback HTTP istemcisi, sahip anahtarı                        |
| `src/safety.ts`     | Tehlikeli işlem kuralları, maskeleme                           |
| `src/files.ts`      | Yükleme dosyası denetimi, ikili yanıtları kaydetme             |
| `src/output.ts`     | Sonuç biçimi, kesme / sayfalama                                |
| `openapi.json`      | API belgesinin kopyası (`openapi:update` üretir)               |
