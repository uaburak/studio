# Studio

Tek kişilik sosyal medya içerik stüdyosu. Markalar için Instagram, Facebook ve LinkedIn'e post,
carousel, story ve Reels üretir; yapay zekâ sohbetiyle planlar, tasarlar, kontrol eder, onaylatır
ve zamanında paylaşır.

Bugün üç parçadan oluşur:

- **Mac uygulaması** (`apps/desktop`, Electron + React): ana yüzey. Yerel sunucuyu (API, yerel ağ
  geçidi, worker) kendisi başlatır; veri, üretim ve render Mac'te kalır.
- **iPhone uygulaması** (`apps/apple/StudioIOS`, UIKit): Mac'e yerel ağdan ya da Cloudflare Tunnel
  üzerinden bağlanan uzaktan kumanda (sohbet, postlar, onay, zamanlama, bildirim).
- **Bulut yayıncı** (`apps/cloud-publisher`, Cloudflare Worker, isteğe bağlı): Mac uyurken zamanı
  gelen postları paylaşır. Studio'nun buluttaki tek parçası.

Mimari tek sayfada: [docs/MIMARI.md](docs/MIMARI.md). Güncel durum ve açık işler:
[docs/DENETIM-PLANI.md](docs/DENETIM-PLANI.md).

## Depo yapısı

| Klasör                 | İçerik                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`         | Mac uygulaması (Electron + React); sunucuyu başlatır ve gözetir, tuval düzenleyici, paketleme                  |
| `apps/api`             | API (Hono, Cloudflare Workers çalışma zamanı; Mac'te `wrangler dev`): D1, R2, `Hub` Durable Object, LAN geçidi |
| `apps/worker`          | Üretim worker'ı (Node): sohbet ajanı, içerik üretimi, render, Reels, görsel, kontroller, yerel yayın           |
| `apps/cloud-publisher` | Yalnızca zamanlanmış postları paylaşan Cloudflare Worker                                                       |
| `apps/apple`           | iPhone uygulaması (`StudioIOS`) ve ortak Swift çekirdeği (`StudioKit`)                                         |
| `packages/contract`    | Ortak zod şemaları ve tipli API istemcisi (TypeScript tarafının tek sözleşmesi)                                |
| `packages/design-kit`  | Slayt HTML sözleşmesi, render ve kontrol yardımcıları                                                          |
| `packages/publishers`  | Instagram, Facebook, LinkedIn yayın durum makineleri                                                           |
| `agent/skills`         | Sohbet ajanının çalışma anı skill'leri                                                                         |
| `docs/`                | Mimari, paketleme, denetim planı, yol haritası                                                                 |
| `spikes/`              | Eski denemeler; pnpm çalışma alanına dahil değil                                                               |

## Gereksinimler

- macOS (Apple Silicon), Node 24 (`.nvmrc`), pnpm 12.21.0 (`package.json` → `packageManager`;
  kurulum: `npm install -g pnpm@12.21.0`).
- Üretim için en az bir yapay zekâ girişi: Claude Code (`claude`), ya da Ayarlar → Yapay zekâ'dan
  Gemini / OpenAI anahtarı. Render için Chromium (Ayarlar → Gelişmiş → Araçlar indirir), Reels için
  `ffmpeg`. Ayrıntı: [docs/PACKAGING.md](docs/PACKAGING.md#ayrıca-kurulması-gerekenler).
- Post tuvali için Wecra düzenleyicisinin kopyası (kapalı kaynak, git'e girmez):
  `node apps/desktop/scripts/vendor-wecra.mjs` (DesignerV2 deposu bu deponun yanındayken; başka
  yerdeyse `--repo <yol>`). Yoksa tip denetimi ve testler yine çalışır, tuval açılmaz.

## Çalıştırma

```sh
pnpm install
pnpm dev          # Mac uygulaması (geliştirme); API, geçit ve worker'ı kendisi başlatır
```

Veri `~/Library/Application Support/Studio` altındadır; göçler her açılışta, önce yedek alınarak
uygulanır. Yalnızca API'yi denemek için: `pnpm --filter @studio/api dev` (127.0.0.1:8787) ve ayrı
terminalde `pnpm dev:worker`; ayrıntı [apps/worker/README.md](apps/worker/README.md).

## Paketleme

```sh
pnpm package      # apps/desktop/release/mac-arm64/Studio.app (+ zip)
```

Ad-hoc imzalı, notarize edilmemiş; imza, notarize ve güncelleme ayarları [docs/PACKAGING.md](docs/PACKAGING.md).

## Kontroller

```sh
pnpm typecheck   # TypeScript
pnpm lint        # Biome; düzeltmek için: pnpm lint:fix
pnpm test        # Vitest (API testleri workerd içinde koşar)
swift test --package-path apps/apple/StudioKit
xcodebuild -project apps/apple/StudioIOS/StudioIOS.xcodeproj -scheme StudioIOS \
  -destination 'generic/platform=iOS Simulator' build-for-testing
```

## Belgeler

- [docs/MIMARI.md](docs/MIMARI.md): süreçler, portlar, veri yerleri, kimlik doğrulama, işler, yayın
- [docs/PACKAGING.md](docs/PACKAGING.md): Studio.app paketi, alt süreçler, sağlık, imza
- [docs/DENETIM-PLANI.md](docs/DENETIM-PLANI.md): denetim bulguları, kararlar, ilerleme
- [docs/ROADMAP-desktop.md](docs/ROADMAP-desktop.md): masaüstü yol haritası (durumlarıyla)
- [apps/api/README.md](apps/api/README.md), [apps/worker/README.md](apps/worker/README.md),
  [apps/cloud-publisher/README.md](apps/cloud-publisher/README.md),
  [apps/apple/README.md](apps/apple/README.md), [apps/desktop/docs/editor.md](apps/desktop/docs/editor.md)
- [PLAN.md](PLAN.md): ilk plan (tarihsel)

## Notlar

- Cloudflare'de hiçbir şey dağıtılmadı; `wrangler deploy` yalnızca bulut yayıncı için ve sahibi tarafından çalıştırılır.
- D1 şeması `apps/api/src/db/schema.ts`; yeni göç: `pnpm --filter @studio/api db:generate --name <ad>`
  (ardından `apps/api/src/lib/health.ts` → `LATEST_MIGRATION`).
- Bağımlılık sürümleri `pnpm-workspace.yaml` içindeki `catalog` bölümünde tek yerden sabitlenir.
