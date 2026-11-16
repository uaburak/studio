# Studio

Tek kullanıcılı sosyal medya içerik stüdyosu. Mimari ve kararlar için [PLAN.md](PLAN.md), iş bölümü için [TASKS.md](TASKS.md).

## Depo yapısı

| Klasör                | İçerik                                                                            |
| --------------------- | --------------------------------------------------------------------------------- |
| `apps/api`            | Cloudflare Workers API (Hono), `Hub` Durable Object (WebSocket), D1 (Drizzle), R2 |
| `apps/web`            | Web arayüzü (Vite + React + Tailwind)                                             |
| `apps/worker`         | Mac worker (Node): hub'a bağlanır, işleri çalıştırır                              |
| `packages/contract`   | Ortak zod şemaları: sağlık yanıtı, iş, worker–hub protokolü, tipli API istemcisi  |
| `packages/design-kit` | Tasarım kiti (şimdilik boş kabuk)                                                 |
| `packages/publishers` | Yayın bağdaştırıcıları (şimdilik boş kabuk)                                       |
| `agent/`              | Üretim ajanının çalışma alanı (şimdilik yalnızca README)                          |

`spikes/` pnpm çalışma alanına dahil değildir; her deneme kendi başına kurulur.

## Gereksinimler

- Node 24 (`.nvmrc`)
- pnpm 12.21.0 (`package.json` → `packageManager`). Kurulum: `npm install -g pnpm@12.21.0`
  (Corepack pnpm 12'yi henüz çalıştıramıyor.)

## Kurulum

```sh
pnpm install
pnpm --filter @studio/api db:migrate   # yerel D1 veritabanına migration uygular
```

## Çalıştırma

```sh
pnpm dev          # API (http://127.0.0.1:8787) + web (http://127.0.0.1:5173)
pnpm dev:worker   # ayrı terminalde: Mac worker, yerel hub'a bağlanır
```

Web sayfası `/api/health` yanıtını gösterir; Vite `/api` isteklerini yerel API'ye yönlendirir.

Worker ayarları ortam değişkenlerinden okunur; liste ve varsayılanlar için `apps/worker/.env.example`.
Yerel değişiklik gerekirse `apps/worker/.env` oluşturun (git'e girmez).

Uçtan uca kontrol (API çalışırken): `pnpm --filter @studio/worker smoke` — worker'ı başlatır,
bir `demo.echo` işi kuyruğa koyar ve sonucun döndüğünü doğrular.

## Kontroller

```sh
pnpm typecheck   # TypeScript (strict)
pnpm lint        # Biome (lint + format denetimi); düzeltmek için: pnpm lint:fix
pnpm test        # Vitest (API testleri Workers çalışma ortamında koşar)
pnpm build       # web paketi, worker paketi, API için wrangler --dry-run
```

## Notlar

- Her şey yereldir. Cloudflare'de hiçbir kaynak oluşturulmadı; `wrangler deploy` ve `wrangler login` çalıştırmayın.
- D1 şeması `apps/api/src/db/schema.ts`; migration üretmek için `pnpm --filter @studio/api db:generate`.
- `wrangler.jsonc` değişirse tipleri yenileyin: `pnpm --filter @studio/api cf-typegen`.
- Bağımlılık sürümleri `pnpm-workspace.yaml` içindeki `catalog` bölümünde tek yerden sabitlenir.
