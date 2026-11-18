# Studio.app paketleme (S3, P1, P2, P9)

Studio, depo klasörü, terminal, pnpm, Node ya da `../DesignerV2` olmadan çift tıklanarak açılan
bir `Studio.app` olarak paketlenir. Apple Developer üyeliği olmadığı için (S8) uygulama şimdilik
**ad-hoc imzalıdır**, notarize edilmez ve otomatik güncelleme kapalıdır; üçü de aşağıdaki
ayarlarla sonradan açılır.

## Paketi oluşturmak

```sh
pnpm package                       # kökten; ya da: pnpm --filter @studio/desktop package
```

Gerekenler: `pnpm install` yapılmış depo ve Wecra düzenleyicisinin kopyası
(`apps/desktop/src/renderer/vendor/wecra-editor`, git'e girmez; `node apps/desktop/scripts/vendor-wecra.mjs`).
İnternet gerekmez: Electron, pnpm'in kurduğu kopyadan alınır.

`scripts/package.mjs` sırasıyla:

1. `electron-vite build` (Wecra yoksa durur: paketlenen sürümde düzenleyici olmalı),
2. `scripts/build-host.mjs` → `out/host` (aşağıda),
3. `out/package`: `main`, `preload`, `renderer` ve bağımlılıksız bir `package.json` (asar'a
   node_modules girmez),
4. electron-builder (`apps/desktop/electron-builder.config.cjs`).

Çıktı (git'e girmez): `apps/desktop/release/mac-arm64/Studio.app` ve
`apps/desktop/release/Studio-<sürüm>-arm64.zip`. DMG için `STUDIO_DMG=1 pnpm package` (DMG
hazırlanırken bir disk görüntüsü bağlanır).

Simge: `apps/desktop/build/icon.svg` geçici; yenisini koyup `node apps/desktop/scripts/make-icon.mjs`
çalıştır (`build/icon.icns` ve `build/icon.png` yeniden üretilir).

## Paketin içi

```
Studio.app/Contents/
  MacOS/Studio                 Electron (sigortaları ayarlı)
  Resources/app.asar           uygulama: main, preload, renderer (Wecra dahil) — ~23 MB
  Resources/host/              sunucu, depodan bağımsız — ~250 MB
    manifest.json              sürüm, son göç, Chromium sürümü
    bin/node-shim.cjs          Node alt süreçlerine önce yüklenir
    bin/studio-vision          Apple Vision yardımcısı (apps/vision-helper, swift build -c release)
    api/index.js, wrangler.json, migrations/   API'nin derlenmiş Worker paketi + D1 göçleri
    gateway/lan-gateway.mjs    yerel ağ geçidi
    worker/main.js             worker, esbuild ile düz JS (tsx yok)
    agent/skills/              sohbet ajanının skill'leri
    node_modules/              wrangler + miniflare + workerd, sharp, playwright-core
  Frameworks/                  Electron (~254 MB)
```

Toplam ~530 MB; zip ~135 MB.

## Alt süreçler: geliştirme ve paket

Düzen açıkça seçilir (`apps/desktop/src/main/host/layout.ts`): uygulama paketliyse paket düzeni,
değilse çalıştığı depo (ya da Ayarlar → Gelişmiş → Depo klasörü). Eski "sabit geliştirici
klasörü" geri dönüşü kaldırıldı; ikisi de yoksa sunucu açıkça hata verir.

| Süreç  | Geliştirme (depo)                                                                                | Paket (Studio.app)                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Node   | giriş kabuğunun PATH'indeki `node`                                                               | uygulamanın kendi ikilisi, `ELECTRON_RUN_AS_NODE=1` + `--require host/bin/node-shim.cjs`                                                                                             |
| Göçler | `apps/api/node_modules/wrangler … d1 migrations apply DB --local --persist-to <durum>/api/state` | `host/node_modules/wrangler … --config <durum>/runtime/api/wrangler.json` (aynı `--persist-to`)                                                                                      |
| API    | `wrangler dev` (cwd `apps/api`, kaynak dosyalardan)                                              | `wrangler dev` derlenmiş `host/api/index.js` ile (`no_bundle`), yapılandırma ve wrangler'ın geçici dosyaları durum klasöründe (`runtime/api`), uygulamanın içine hiçbir şey yazılmaz |
| Geçit  | `apps/api/scripts/lan-gateway.mjs`                                                               | `host/gateway/lan-gateway.mjs`                                                                                                                                                       |
| Worker | `node --env-file-if-exists=<depo>/.env --import tsx src/main.ts` (cwd `apps/worker`)             | `host/worker/main.js` (cwd `<durum>/worker`), `.env` okunmaz, `STUDIO_SKILLS_DIR=host/agent/skills`                                                                                  |
| Tünel  | PATH'teki `cloudflared`                                                                          | aynı                                                                                                                                                                                 |

Görsel yardımcısı (`studio-vision`, Apple Vision; etiketleme N12 ve etiket koruma U9): worker
önce `STUDIO_VISION_HELPER`'a, sonra kendi yanındaki `host/bin/studio-vision`'a (paket), sonra
depodaki `apps/vision-helper/.build/release/studio-vision`'a bakar. Geliştirmede bir kez
`swift build -c release --package-path apps/vision-helper` gerekir; `build-host.mjs` paket için
derler (Xcode yoksa uyarır, paket onsuz çıkar ve özellikler bunu Türkçe söyler).

Veri yeri değişmez: `~/Library/Application Support/Studio` (`api/state/v3/…` düzeni aynı;
veritabanı, R2 ve Durable Object dosyaları geliştirme ve paket arasında ortak). Göçten önce
veritabanı yedeği alınır (G5).

Node shim: Electron'un Node'u `process.versions.electron` bildirir; yargs gibi kütüphaneler bunu
görünce paketlenmiş Electron uygulamasında olduklarını sanıp wrangler'ın ilk argümanını atar.
Shim bu alanı siler. Worker, Claude/Gemini/Codex CLI'larının MCP köprüsünü başlatırken
`ELECTRON_RUN_AS_NODE=1`'i onlara da geçirir (yoksa CLI ikinci bir Studio açardı).

**RunAsNode sigortası açık kalır** (bilinçli takas): Mac'te Node kurulu olmasın diye alt
süreçler uygulamanın ikilisiyle çalışır. Bedeli: `ELECTRON_RUN_AS_NODE=1 Studio.app/…/Studio`
herkesin elinde Studio'nun izinleriyle (ör. Masaüstü erişimi verildiyse) çalışan bir Node olur.
Diğer sigortalar: çerez şifreleme açık, ASAR bütünlüğü açık, yalnızca asar'dan yükleme açık,
`NODE_OPTIONS` ve `--inspect` kapalı, file:// ek ayrıcalıkları kapalı.

## Bir veri klasörü, bir sunucu (P9)

Çocukları başlatmadan önce sunucu `~/Library/Application Support/Studio/host.lock` dosyasını
O_EXCL ile alır (pid + süreç başlangıç zamanı). İkinci bir Studio (ör. paket açıkken geliştirme
kopyası) çalışan sunucuya bağlanır; bağlanamıyorsa "Bu veri klasörünü şu an başka bir Studio
sunucusu kullanıyor…" der ve veritabanına dokunmaz. Süreci ölmüş ya da pid'i başka bir sürece
geçmiş kilit bayattır ve devralınır. Sunucu durunca kilit bırakılır.

## Sağlık (P9)

`GET /api/health` herkese özet döner (`status` yalnızca API ve veritabanı). Mac'in kendisi,
worker ve eşli cihazlar ayrıca `components` alır: veritabanı, medya deposu (R2), veritabanı
sürümü (göç seviyesi), worker, tuval çalıştırıcısı, anahtar kasası, bulut yayıncı (son eşitleme)
ve uzaktan erişim tüneli; her biri `ok` / `warn` / `fail` + Türkçe etiket ve açıklama. Ayarlar →
Gelişmiş → Sunucu sağlığı bunu gösterir. Yeni bir göç eklerken `apps/api/src/lib/health.ts`
`LATEST_MIGRATION` güncellenir (test hatırlatır).

## Ayrıca kurulması gerekenler

Ayarlar → Gelişmiş → Araçlar her birinin durumunu ve tek satırlık kurulumunu gösterir:

- **Chromium** (görsel ve Reels oluşturma): Playwright'ın önbelleğinde (`~/Library/Caches/ms-playwright`)
  doğru sürüm varsa o kullanılır; yoksa Ayarlar'daki "Chromium'u indir" düğmesi paketteki
  Playwright kurucusuyla durum klasörüne (`browsers/`) indirir (~100 MB, ilerleme gösterilir).
  Kendiliğinden hiçbir şey indirilmez.
- **ffmpeg** (Reels): `brew install ffmpeg`.
- **whisper.cpp** (isteğe bağlı, Reels altyazıları): `brew install whisper-cpp` + bir ggml modeli
  (`~/.studio/models/`).
- **Claude Code / Gemini CLI / Codex**: giriş kabuğunun PATH'inden, arka planda bulunur.
- **cloudflared** (yalnızca uzaktan erişim): `brew install cloudflared`.

Arama sırası: giriş kabuğunun PATH'i, sonra `/opt/homebrew/bin`, `/usr/local/bin`,
`~/.local/bin`, `~/.studio/bin`.

## Yapay zekâ anahtarları

Paketlenmiş uygulama depodaki `.env`'i okumaz. Worker'ın anahtarları:

- Gemini ve OpenAI: Ayarlar → Yapay zekâ (API'nin kasası; değişmedi).
- ElevenLabs, ses kimliği, eski usul bulut yayıncı ve `STUDIO_*` ayarları: durum klasöründeki
  `worker-env.json` (0600, her değer safeStorage ile şifreli). Ayarlar → Gelişmiş → Worker
  anahtarları'ndan girilir; adlar gösterilir, değerler asla.
- Geliştirme kopyası açılınca depodaki `.env`'in izinli adları (sağlayıcı anahtarları ve
  `STUDIO_*`; sunucunun kendi değişkenleri hariç) bu depoya **kendiliğinden** aktarılır; `.env`
  değişirse yeniden. Böylece paket aynı anahtarları bulur. Uygulama dosyayı kendisi okur; hiçbir
  değer kaydedilmez ya da gösterilmez.

Not: ad-hoc imzada her yeni derleme macOS'a yeni bir uygulama gibi görünür; Anahtar Zinciri
"Studio Safe Storage" erişimini her sürümde bir kez sorabilir ("Her Zaman İzin Ver"). Developer ID
imzası bunu kalıcı çözer.

## Başlangıç, uyku, çökme kaydı, güncelleme (P2)

- **Mac açılınca Studio'yu başlat**: Ayarlar → Gelişmiş (yalnızca Studio.app; macOS 13+ giriş
  öğesi, onay isterse Sistem Ayarları → Genel → Giriş Öğeleri).
- **Mac'i uyanık tut** (varsayılan açık): işler sürerken / bekliyorken ya da bir saat içinde
  zamanlanmış yayın varken uyku engellenir (ekran kapanabilir).
- **Çökme kaydı**: `crashReporter` yalnızca yerel, `~/Library/Application Support/Studio/logs/crashes`;
  hiçbir yere gönderilmez.
- **Hakkında**: sürüm, paket / geliştirme kopyası, güncelleme durumu.
- **Otomatik güncelleme**: electron-updater bağlı ama kapalı
  (`apps/desktop/src/main/system-services.ts` → `UPDATES.enabled = false`). Squirrel.Mac,
  imzası çalışan uygulamanınkiyle eşleşmeyen güncellemeyi reddeder; ad-hoc imza her derlemede
  değiştiği için Developer ID gelmeden açılamaz.

## Doğrulama: `--self-test`

Pencere açmadan, geçici bir durum klasörü, boş portlar, sahte Anahtar Zinciri ve kapalı yapay
zekâ ile sunucuyu başlatır; sağlık ucunu, boş veritabanının göçlerini, API ile marka + içerik
oluşturmayı, worker'ın ve gizli tuval çalıştırıcısının bağlanmasını denetler, her şeyi kapatır;
0 / 1 ile çıkar ve JSON rapor yazar. Çalışan Studio'ya ve gerçek veri klasörüne dokunmaz.

```sh
# geliştirme (önce: pnpm --filter @studio/desktop build)
cd apps/desktop && ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron . --self-test
# paket
apps/desktop/release/mac-arm64/Studio.app/Contents/MacOS/Studio --self-test
```

## İmza, notarize, güncelleme: sonradan açmak

Hepsi ortam değişkeniyle (`electron-builder.config.cjs`):

| Değişken                                                       | Ne yapar                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STUDIO_APP_ID`                                                | paket kimliği (varsayılan `net.burakkoc.studio`)                                                                                                       |
| `STUDIO_SIGN_IDENTITY="Developer ID Application: Ad (TEAMID)"` | ad-hoc yerine Developer ID imzası (sertifika Anahtar Zinciri'nde)                                                                                      |
| `STUDIO_NOTARIZE=1`                                            | Apple'a notarize ettirir: `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` ya da `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` |
| `STUDIO_UPDATE_URL=https://…/studio/`                          | genel (generic) güncelleme kaynağı; `app-update.yml` pakete yazılır                                                                                    |
| `STUDIO_DMG=1`                                                 | zip'in yanında DMG                                                                                                                                     |

Adımlar (Apple Developer üyeliğinden sonra):

1. Xcode → Settings → Accounts'tan "Developer ID Application" sertifikasını oluştur.
2. `STUDIO_SIGN_IDENTITY=… STUDIO_NOTARIZE=1 APPLE_API_KEY=… pnpm package`. Sertleştirilmiş
   çalışma zamanı ve yetkiler (`build/entitlements.mac.plist`: JIT, imzasız yürütülebilir bellek,
   kütüphane doğrulamasını kapatma — workerd, sharp ve Node alt süreçleri için) zaten hazır.
3. Güncellemeler için: `UPDATES = { enabled: true, feedUrl: "https://…" }`
   (`system-services.ts`), paketlerken `STUDIO_UPDATE_URL` aynı adres; `release/` içindeki zip,
   `latest-mac.yml` ve `.blockmap` o adrese yüklenir.

Bu Mac'te derlenen Studio.app doğrudan açılır (karantina işareti yok). Ad-hoc zip'i indirip
başka bir Mac'te açarken Gatekeeper engeller: bir kez açmayı dene, sonra Sistem Ayarları →
Gizlilik ve Güvenlik → "Yine de Aç".

Kurulum: `Studio.app`'i `/Applications`'a sürükle. Geliştirme kopyası açıkken paketi açarsan
paket, çalışan sunucuya bağlanır (ikisi aynı veri klasörünü kullanır); paketin kendi sunucusunu
çalıştırması için önce geliştirme kopyasını kapat.
