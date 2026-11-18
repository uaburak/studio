/**
 * P3 live check against a PRIVATE API instance (its own --persist-to; never :8787/:8790),
 * with Meta replaced by FakeGraph (no real network calls to Meta):
 *
 *   connect an Instagram account (Facebook Login code → exchange → pick the account)
 *   → an Instagram image post is refused in local mode (Meta needs a public URL)
 *   → a Reel (video pushed as bytes, which works from a Mac) + approve → preflight
 *   → schedule ~20 s ahead → the worker's schedule loop publishes it locally at the
 *     time (FakeGraph; the MP4 is a synthetic container, FakeGraph does not decode it)
 *   → publish log with permalink → the notification feed (`/api/publish-logs?finishedAfter=`)
 *   → also: reschedule + cancel of a second schedule.
 *
 * Start the API first (the token vault key and the FakeGraph origin are passed as vars):
 *
 *   S=$(mktemp -d)
 *   pnpm --filter @studio/api exec wrangler d1 migrations apply DB --local --persist-to $S/api
 *   pnpm --filter @studio/api exec wrangler dev --port 8797 --ip 127.0.0.1 --persist-to $S/api \
 *     --inspector-port 9337 --var WORKER_TOKEN:test-token --var TOKEN_ENCRYPTION_KEY:$(openssl rand -base64 32) \
 *     --var STUDIO_OWNER_SECRET:test-owner --var META_GRAPH_BASE_URL:http://127.0.0.1:8798 &
 *   STUDIO_E2E_API=http://127.0.0.1:8797 STUDIO_WORKER_TOKEN=test-token STUDIO_E2E_STATE=$S/worker \
 *     STUDIO_OWNER_SECRET=test-owner \
 *     STUDIO_FAKE_GRAPH_PORT=8798 pnpm --filter @studio/worker exec tsx scripts/e2e-publish.ts
 */

import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createApiClient, type Schedule } from "@studio/contract";
import sharp from "sharp";
import { FakeGraph } from "../../../packages/publishers/src/testing/index.ts";
import { loadAgentSettings } from "../src/agent.ts";
import { createStudioApi } from "../src/api.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { silentLogger } from "../src/log.ts";
import type { SchedulePublishDeps } from "../src/publish/handler.ts";
import { SchedulePoller } from "../src/publish/poller.ts";
import { OwnerWebSocket, ownerFetch, requireOwnerSecret } from "./owner.ts";

const apiBase = process.env.STUDIO_E2E_API ?? "";
const workerToken = process.env.STUDIO_WORKER_TOKEN ?? "";
const stateDir = process.env.STUDIO_E2E_STATE ?? "";
const fakePort = Number(process.env.STUDIO_FAKE_GRAPH_PORT ?? 8798);
if (!apiBase || !workerToken || !stateDir) {
  console.error("set STUDIO_E2E_API, STUDIO_WORKER_TOKEN and STUDIO_E2E_STATE");
  process.exit(2);
}
if (/:(8787|8790)\b/.test(apiBase)) {
  console.error("refusing to run against the shared API (8787/8790); use a private instance");
  process.exit(2);
}
mkdirSync(stateDir, { recursive: true });

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  log(`ok  ${msg}`);
}

// --- FakeGraph, in process and over HTTP (the API's Graph origin) -----------------------
const fake = new FakeGraph({ imageProcessingMs: 1_000, videoProcessingMs: 3_000 });
fake.clock.now = () => Date.now();
// Fresh ids per run: an account already connected to another brand is not taken over.
const IG_ID = `1784${Date.now()}`;
const PAGE_ID = `50${Date.now()}`;
fake.addPage(PAGE_ID, `EAApage${PAGE_ID}-e2e-000000000001`, { name: "MTM Agro", igUserId: IG_ID });
const LOGIN_CODE = "e2e-login-code";
const graphHttp = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "https://graph.facebook.com");
  if (url.pathname.endsWith("/oauth/access_token") && url.searchParams.has("code")) {
    if (url.searchParams.get("code") !== LOGIN_CODE) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid verification code", code: 100 } }));
      return;
    }
    const short = "EAAshort-e2e-0000000000000001";
    fake.addUserToken(short, { expiresAt: Date.now() + 3600_000 });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: short, token_type: "bearer", expires_in: 3600 }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const response = await fake.fetch(
    new Request(url.toString(), {
      method: req.method ?? "GET",
      headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    }),
  );
  res.writeHead(response.status, {
    "content-type": response.headers.get("content-type") ?? "application/json",
  });
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>((resolve) => graphHttp.listen(fakePort, "127.0.0.1", resolve));
log(`FakeGraph on http://127.0.0.1:${fakePort}`);

requireOwnerSecret();
const api = createApiClient({ baseUrl: apiBase, fetch: ownerFetch, WebSocket: OwnerWebSocket });

// --- 1. Connect a (fake) Instagram account the way the Mac does -------------------------
const health = await fetch(`${apiBase}/api/health`).then((r) => r.json());
check(health.status === "ok", "private API is up");
const status0 = await api.publishing.status();
check(status0.vaultReady && status0.mode === "local", "vault key present, local publishing mode");

const brand = await api.brands.create({
  name: "P3 Canlı Deneme",
  slug: `p3-e2e-${Date.now().toString(36)}`,
});
const exchanged = await api.socialAccounts.exchangeMeta({
  appId: fake.opts.appId,
  appSecret: fake.opts.appSecret,
  code: LOGIN_CODE,
  redirectUri: "http://localhost:8793/meta/callback",
});
check(
  exchanged.longLived && exchanged.pages.length === 1,
  "Facebook Login code exchanged for a long-lived token; 1 Page listed",
);
const discovered = await api.socialAccounts.discoverMeta({
  brandId: brand.id,
  userAccessToken: exchanged.userAccessToken,
  userTokenExpiresAt: exchanged.expiresAt,
  selections: [{ pageId: PAGE_ID, facebook: false, instagram: true }],
});
const account = discovered.connectedAccounts[0];
check(
  account?.platform === "instagram" && account.hasToken,
  `connected ${account?.handle} (Instagram only, token vaulted)`,
);
const checked = await api.socialAccounts.checkToken(account.id, {
  live: true,
  appId: fake.opts.appId,
  appSecret: fake.opts.appSecret,
});
check(checked.tokenHealth === "valid", "live token health (debug_token): valid");

// --- 2. Local mode: an image post is refused, a Reel is accepted ------------------------
const jpeg = await sharp({
  create: { width: 1080, height: 1920, channels: 3, background: "#1f6f43" },
})
  .jpeg({ quality: 90 })
  .toBuffer();
const cover = await api.assets.upload({
  brandId: brand.id,
  kind: "image",
  source: "generated",
  width: 1080,
  height: 1920,
  file: new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }),
  filename: "cover.jpg",
});
const imagePost = await api.contents.create({
  brandId: brand.id,
  type: "post",
  title: "Görsel post",
  targetPlatforms: ["instagram"],
});
await api.contents.versions.create(imagePost.id, {
  origin: "generated",
  slides: [{ html: "<html><body>Görsel</body></html>", width: 1080, height: 1350 }],
});
const refused = await api.schedules.preflight({
  contentId: imagePost.id,
  socialAccountIds: [account.id],
});
check(
  !refused.ok && refused.targets[0]?.errors.some((e) => e.code === "LOCAL_MEDIA_NOT_PUBLIC"),
  `image post refused in local mode: “${refused.targets[0]?.errors[0]?.message}”`,
);

// A synthetic MP4 container (ftyp + mdat); FakeGraph accepts the bytes as a Reel upload.
const ftyp = Buffer.from([
  0,
  0,
  0,
  0x18,
  ...Buffer.from("ftypmp42"),
  0,
  0,
  0,
  0,
  ...Buffer.from("mp42isom"),
]);
const payload = Buffer.alloc(256 * 1024, 7);
const mdatHeader = Buffer.alloc(8);
mdatHeader.writeUInt32BE(payload.length + 8, 0);
mdatHeader.write("mdat", 4);
const mp4 = Buffer.concat([ftyp, mdatHeader, payload]);
const video = await api.assets.upload({
  brandId: brand.id,
  kind: "video",
  source: "generated",
  width: 1080,
  height: 1920,
  durationMs: 8_000,
  file: new Blob([new Uint8Array(mp4)], { type: "video/mp4" }),
  filename: "reel.mp4",
});
const content = await api.contents.create({
  brandId: brand.id,
  type: "reel",
  title: "Hasat Reels (P3 canlı)",
  targetPlatforms: ["instagram"],
  caption: "Hasat zamanı geldi. #mtmagro",
});
const version = await api.contents.versions.create(content.id, {
  origin: "generated",
  slides: [
    {
      html: `<html><body><div data-video-asset-id="${video.id}" data-cover-asset-id="${cover.id}" data-duration-ms="8000">Hasat</div></body></html>`,
      width: 1080,
      height: 1920,
    },
  ],
  renderedAssetIds: [cover.id],
});
// No check run for a hand-made version: approve past the checks gate (E7).
await api.contents.approve(content.id, { hash: version.contentHash, acknowledgeChecks: true });
const preflight = await api.schedules.preflight({
  contentId: content.id,
  socialAccountIds: [account.id],
});
check(
  preflight.ok && preflight.targets[0]?.kind === "instagram.reel",
  "preflight ok (instagram.reel, local mode)",
);

// --- 3. Schedule ~20 s ahead; a second one to move and cancel ----------------------------
const at = new Date(Date.now() + 20_000);
const schedule = await api.schedules.create({
  contentId: content.id,
  socialAccountId: account.id,
  scheduledAt: at.toISOString(),
});
check(schedule.status === "pending", `scheduled for ${at.toISOString()}`);

const content2 = await api.contents.create({
  brandId: brand.id,
  type: "post",
  title: "İkinci post",
  targetPlatforms: ["linkedin"],
});
const li = await api.socialAccounts.create({
  brandId: brand.id,
  platform: "linkedin",
  handle: "MTM",
  externalId: "urn:li:person:e2e",
});
const v2 = await api.contents.versions.create(content2.id, {
  origin: "generated",
  slides: [{ html: "<html><body>2</body></html>", width: 1080, height: 1350 }],
});
await api.contents.approve(content2.id, { hash: v2.contentHash, acknowledgeChecks: true });
const s2 = await api.schedules.create({
  contentId: content2.id,
  socialAccountId: li.id,
  scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
});
const moved = await api.schedules.update(s2.id, {
  scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
});
check(
  Date.parse(moved.scheduledAt) - Date.parse(s2.scheduledAt) > 86_000_000,
  "second schedule moved one day later (calendar drag)",
);
const cancelled = await api.schedules.cancel(s2.id);
check(cancelled.status === "cancelled", "second schedule cancelled");

// --- 4. The worker's loop publishes at the time (local mode, FakeGraph) -------------------
const deps: SchedulePublishDeps = {
  api: createStudioApi({ baseUrl: apiBase, workerToken }),
  gate: new ClaudeGate({
    runner: async () => {
      throw new Error("no Claude in this check");
    },
  }),
  settings: loadAgentSettings({ STUDIO_WORKER_TOKEN: workerToken }),
  logger: silentLogger,
  health: () => ({ state: "ok", message: "ok", checkedAt: new Date().toISOString() }),
  stateDir,
  renderer: () => {
    throw new Error("slides are already rendered");
  },
  publisherFetch: fake.fetch as typeof fetch,
  inFlightSchedules: new Set(),
};
const poller = new SchedulePoller(deps, { controlIntervalMs: 1_000 });
poller.start(2_000);
const since = new Date(Date.now() - 1_000).toISOString();

let final: Schedule = schedule;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  final = await api.schedules.get(schedule.id);
  if (final.status === "published" || final.status === "failed") break;
  await new Promise((r) => setTimeout(r, 1_000));
}
await poller.stop();
check(
  final.status === "published",
  `published at ${new Date().toISOString()} (scheduled ${at.toISOString()})`,
);
check(final.delivery === "local", "delivery recorded as local (this Mac)");
check(Date.now() >= at.getTime(), "not published before its time");
check(
  typeof final.permalink === "string" && final.permalink.startsWith("https://"),
  `permalink ${final.permalink}`,
);
check(
  fake.igPublishedMedia(IG_ID).length === 1 && fake.stats.duplicatePublishAttempts === 0,
  "exactly one Instagram media on FakeGraph",
);
check(
  fake.calls.some((c) => c.host.startsWith("rupload.") && c.bodyBytes === mp4.length),
  `video bytes pushed to rupload (${mp4.length} B)`,
);

const logs = await api.schedules.logs(schedule.id);
check(
  logs.items.some((l) => l.status === "succeeded" && l.permalink === final.permalink),
  "publish log has the permalink",
);

// --- 5. Notification event: the feed the Mac polls -------------------------------------
const feed = await api.publishing.logs({ finishedAfter: since });
const event = feed.items.find((i) => i.schedule.id === schedule.id);
check(
  event?.log.status === "succeeded",
  `notification event: “Yayınlandı: ${event?.contentTitle}” · ${event?.accountHandle} → ${event?.log.permalink}`,
);
const content3 = await api.contents.get(content.id);
check(content3.status === "published", "content is published");

console.log(
  JSON.stringify(
    {
      scheduleId: schedule.id,
      scheduledAt: at.toISOString(),
      status: final.status,
      delivery: final.delivery,
      permalink: final.permalink,
      feedSince: since,
      notificationEvent: {
        title: `Yayınlandı: ${event?.contentTitle}`,
        body: `Instagram · ${event?.accountHandle}`,
        url: event?.log.permalink,
      },
      fakeGraphCalls: fake.calls.map((c) => c.route),
    },
    null,
    2,
  ),
);
graphHttp.close();
process.exit(0);
