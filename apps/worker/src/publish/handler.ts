/**
 * `schedule.publish` handler & shared Cloud / Local publishing driver (L2, Faz 3 & Faz 6):
 * - Mode A (Cloud Publisher): pushes orders + SHA-256 verified media to `STUDIO_CLOUD_PUBLISHER_URL`
 *   and syncs `publishing` / `published` (with `permalink`) / `failed` back to `workerSchedules.outcome`.
 * - Mode B (Local Direct Publisher): drives `@studio/publishers` (`instagram.*`, `facebook.*`,
 *   `linkedin.*`, including automatic PDF generation for LinkedIn carousels) using a local
 *   `MediaReader` backed by `StudioApi`, reporting outcomes to `workerSchedules.outcome`.
 */
import { createHash } from "node:crypto";
import {
  ApiError,
  type CloudOrderCreate,
  CloudOrderList,
  type CloudOrderMedia,
  type CloudPublishKind,
  SchedulePublishPayload,
  selectPublishKind as selectKind,
  type WorkerScheduleCredentials,
  type WorkerScheduleDelivery,
} from "@studio/contract";
import sharp from "sharp";
import {
  createPublisher,
  type MachineOptions,
  type MediaReader,
  PublishError,
  type PublishRequest,
  runToCompletion,
  toPublishError,
} from "../../../../packages/publishers/src/index.ts";
import { abortableSleep } from "../claude/gate.ts";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";
import { type ContentRenderDeps, executeContentRender } from "../render/handler.ts";
import { extractReelVersionAssets } from "../video/recipes.ts";
import {
  type CloudPublisherConfig,
  cloudState,
  envCloudPublisherConfig,
  pushKey,
  resolveCloudPublisherConfig,
} from "./cloud-state.ts";

export type { CloudPublisherConfig } from "./cloud-state.ts";

export interface SchedulePublishDeps extends ContentRenderDeps {
  publisherMachineOptions?: Partial<MachineOptions>;
  publisherSleep?: (ms: number) => Promise<void>;
  /** Shared in-flight lock across `schedule.publish` jobs and the 30s poller. */
  inFlightSchedules?: Set<string>;
}

/** Cloud publisher from the worker's environment only (see `resolveCloudPublisherConfig`). */
export function getCloudPublisherConfig(deps: SchedulePublishDeps): CloudPublisherConfig | null {
  return envCloudPublisherConfig(deps);
}

/** Best-effort: tell the API who publishes the schedule (shown in the calendar). */
export async function reportDelivery(
  deps: SchedulePublishDeps,
  scheduleId: string,
  input: WorkerScheduleDelivery,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await deps.api.client.workerSchedules.delivery(
      scheduleId,
      input,
      signal ? { signal } : undefined,
    );
  } catch {
    // Older API or a transient error: the next round reports again.
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function redactToken(text: string, ...secrets: (string | null | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("[REDACTED]");
  }
  return out;
}

function normalizeLinkedInAuthorUrn(externalId: string): string {
  const trimmed = externalId.trim();
  if (/^urn:li:[A-Za-z]+:\S+$/.test(trimmed)) return trimmed;
  return `urn:li:person:${trimmed}`;
}

function hasAiGeneratedMarker(creds: WorkerScheduleCredentials): boolean {
  if (/ai[ _-]?görsel|yapay zek[aâ]/i.test(creds.version.note ?? "")) return true;
  return creds.version.slides.some((s) => /data-ai-generated|ai-image-/i.test(s.html));
}

/** Same rule the API preflight uses (`selectPublishKind` in the contract). */
export function selectPublishKind(
  platform: "instagram" | "facebook" | "linkedin",
  contentType: "post" | "carousel" | "story" | "reel",
  slideCount: number,
): CloudPublishKind {
  return selectKind(platform, contentType, slideCount);
}

interface PreparedMediaAsset {
  assetId: string;
  mediaId: string;
  kind: "image" | "video" | "document";
  mimeType: "image/jpeg" | "image/png" | "video/mp4" | "video/quicktime" | "application/pdf";
  bytes: Uint8Array;
  sha256: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

async function ensurePreparedMediaForSchedule(
  creds: WorkerScheduleCredentials,
  kind: CloudPublishKind,
  deps: SchedulePublishDeps,
  signal: AbortSignal,
): Promise<{ items: PreparedMediaAsset[]; coverAssetId?: string }> {
  const { content, version } = creds;

  if (kind === "linkedin.text") {
    return { items: [] };
  }

  if (kind === "instagram.reel" || kind === "facebook.reel" || kind === "linkedin.video") {
    let reelAssets = extractReelVersionAssets(version);
    if (!reelAssets.videoAssetId) {
      const rendered = await executeContentRender({
        deps,
        brandId: content.brandId,
        contentId: content.id,
        payload: { version: version.version, format: "mp4" },
        signal,
      });
      reelAssets = {
        ...reelAssets,
        videoAssetId: rendered.videoAssetId ?? null,
        coverAssetId: rendered.coverAssetId ?? null,
      };
    }
    if (!reelAssets.videoAssetId) {
      throw new Error("Reels video varlığı (videoAssetId) bulunamadı.");
    }
    const dl = await deps.api.downloadAsset(reelAssets.videoAssetId, {
      maxBytes: 95 * 1024 * 1024,
      signal,
    });
    const mimeType = dl.contentType.includes("quicktime") ? "video/quicktime" : "video/mp4";
    return {
      items: [
        {
          assetId: reelAssets.videoAssetId,
          mediaId: mimeType === "video/quicktime" ? "reel.mov" : "reel.mp4",
          kind: "video",
          mimeType,
          bytes: dl.bytes,
          sha256: sha256Hex(dl.bytes),
          width: 1080,
          height: 1920,
          ...(reelAssets.durationMs ? { durationMs: reelAssets.durationMs } : {}),
        },
      ],
      ...(reelAssets.coverAssetId ? { coverAssetId: reelAssets.coverAssetId } : {}),
    };
  }

  if (kind === "linkedin.document") {
    const rendered = await executeContentRender({
      deps,
      brandId: content.brandId,
      contentId: content.id,
      payload: { version: version.version, format: "pdf" },
      signal,
    });
    if (!rendered.pdfAssetId) {
      throw new Error("LinkedIn belge yayını için PDF üretilemedi.");
    }
    const dl = await deps.api.downloadAsset(rendered.pdfAssetId, {
      maxBytes: 95 * 1024 * 1024,
      signal,
    });
    return {
      items: [
        {
          assetId: rendered.pdfAssetId,
          mediaId: "carousel.pdf",
          kind: "document",
          mimeType: "application/pdf",
          bytes: dl.bytes,
          sha256: sha256Hex(dl.bytes),
        },
      ],
    };
  }

  // Image / Multi-image / Carousel / Story
  let slideAssetIds = version.slides.map((s) => s.renderedAssetId);
  if (slideAssetIds.some((id) => !id)) {
    const rendered = await executeContentRender({
      deps,
      brandId: content.brandId,
      contentId: content.id,
      payload: { version: version.version, format: "jpeg" },
      signal,
    });
    slideAssetIds = rendered.renderedAssetIds;
  }

  const items: PreparedMediaAsset[] = [];
  for (const [idx, rawId] of slideAssetIds.entries()) {
    if (!rawId) throw new Error(`Slayt ${idx + 1} için render edilmiş görsel bulunamadı.`);
    let assetId = rawId;
    let dl = await deps.api.downloadAsset(assetId, { maxBytes: 25 * 1024 * 1024, signal });
    let meta: { width?: number; height?: number; format?: string } | null = await sharp(dl.bytes, {
      animated: false,
    })
      .metadata()
      .catch(() => null);

    // Instagram Graph API rejects images wider than 1440px (PLAN.md §3.5)
    if (kind.startsWith("instagram.") && (meta?.width ?? 0) > 1440) {
      const resized = await sharp(dl.bytes, { animated: false })
        .resize({ width: 1440, withoutEnlargement: true })
        .toColorspace("srgb")
        .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true })
        .withIccProfile("srgb")
        .toBuffer({ resolveWithObject: true });
      const resizedBytes = new Uint8Array(
        resized.data.buffer,
        resized.data.byteOffset,
        resized.data.byteLength,
      );
      const uploaded = await deps.api.client.assets.upload(
        {
          brandId: content.brandId,
          kind: "image",
          source: "generated",
          width: resized.info.width,
          height: resized.info.height,
          file: new Blob([resizedBytes.slice()], { type: "image/jpeg" }),
          filename: `ig-1440-slide-${idx + 1}.jpg`,
        },
        { signal },
      );
      assetId = uploaded.id;
      dl = { bytes: resizedBytes, contentType: "image/jpeg" };
      meta = { width: resized.info.width, height: resized.info.height, format: "jpeg" };
    }

    // Instagram accepts JPEG only: convert anything else (a PNG export, a WebP upload) here,
    // so the bytes match the declared type the cloud publisher and Meta check.
    const isJpeg = meta?.format === "jpeg" || (!meta?.format && dl.contentType.includes("jpeg"));
    if (kind.startsWith("instagram.") && !isJpeg) {
      const converted = await sharp(dl.bytes, { animated: false })
        .flatten({ background: "#ffffff" })
        .toColorspace("srgb")
        .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      const jpegBytes = new Uint8Array(
        converted.data.buffer,
        converted.data.byteOffset,
        converted.data.byteLength,
      );
      const uploaded = await deps.api.client.assets.upload(
        {
          brandId: content.brandId,
          kind: "image",
          source: "generated",
          width: converted.info.width,
          height: converted.info.height,
          file: new Blob([jpegBytes.slice()], { type: "image/jpeg" }),
          filename: `ig-jpeg-slide-${idx + 1}.jpg`,
        },
        { signal },
      );
      assetId = uploaded.id;
      dl = { bytes: jpegBytes, contentType: "image/jpeg" };
      meta = { width: converted.info.width, height: converted.info.height, format: "jpeg" };
    }

    const isPng = dl.contentType.includes("png") || meta?.format === "png";
    const mimeType = isPng && !kind.startsWith("instagram.") ? "image/png" : "image/jpeg";
    const ext = mimeType === "image/png" ? "png" : "jpg";
    items.push({
      assetId,
      mediaId: `slide-${idx + 1}.${ext}`,
      kind: "image",
      mimeType,
      bytes: dl.bytes,
      sha256: sha256Hex(dl.bytes),
      ...(meta?.width ? { width: meta.width } : {}),
      ...(meta?.height ? { height: meta.height } : {}),
    });
  }

  return { items };
}

/**
 * Mode A: Push a pending schedule + media bytes to Cloud Publisher (`PUT /v1/orders/{id}`
 * and `PUT /v1/orders/{id}/media/{mediaId}`).
 */
export async function pushScheduleToCloudPublisher(input: {
  scheduleId: string;
  cloud: CloudPublisherConfig;
  deps: SchedulePublishDeps;
  signal: AbortSignal;
}): Promise<{ orderId: string; mediaUploaded: number; status: string }> {
  const { scheduleId, deps, signal } = input;
  try {
    const pushed = await pushOrder(input);
    const state = cloudState(deps);
    state.pushed.set(scheduleId, pushed.key);
    // A fresh (or replaced, retried) order: its next outcome must be written back.
    if (pushed.status === "scheduled") state.reported.delete(scheduleId);
    await reportDelivery(
      deps,
      scheduleId,
      { delivery: "cloud", cloudSyncedAt: new Date(nowMs(deps)).toISOString(), error: null },
      signal,
    );
    return { orderId: pushed.orderId, mediaUploaded: pushed.mediaUploaded, status: pushed.status };
  } catch (error) {
    if (!signal.aborted && !(error instanceof ApiError && error.status === 409)) {
      const message = error instanceof Error ? error.message : String(error);
      await reportDelivery(
        deps,
        scheduleId,
        { delivery: "cloud", error: message.slice(0, 2000) },
        signal,
      );
    }
    throw error;
  }
}

function nowMs(deps: SchedulePublishDeps): number {
  return (deps.now ?? (() => new Date()))().getTime();
}

/** Turkish summary of a cloud publisher error body (`{ error: { message, issues } }`). */
function cloudErrorText(raw: string): string {
  try {
    const body = JSON.parse(raw) as {
      error?: { message?: string; issues?: { message?: string }[] };
    };
    const issues = (body.error?.issues ?? []).map((i) => i.message).filter(Boolean);
    if (issues.length) return issues.join(" ");
    if (body.error?.message) return body.error.message;
  } catch {
    // not JSON
  }
  return raw.slice(0, 300);
}

async function pushOrder(input: {
  scheduleId: string;
  cloud: CloudPublisherConfig;
  deps: SchedulePublishDeps;
  signal: AbortSignal;
}): Promise<{ orderId: string; mediaUploaded: number; status: string; key: string }> {
  const { scheduleId, cloud, deps, signal } = input;
  const doFetch = deps.publisherFetch ?? globalThis.fetch.bind(globalThis);
  const init = { signal };

  let creds: WorkerScheduleCredentials;
  try {
    creds = await deps.api.client.workerSchedules.credentials(scheduleId, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      await deps.api.client.workerSchedules
        .outcome(
          scheduleId,
          {
            status: "failed",
            attempt: 1,
            error: "İçerik onayı değiştiği için zamanlanmış yayın iptal edildi.",
            accountNeedsReauth: false,
          },
          init,
        )
        .catch(() => undefined);
    }
    throw err;
  }

  if (!creds.accessToken || !creds.account.externalId) {
    const msg = !creds.accessToken
      ? "Sosyal hesap erişim anahtarı bulunamadı; lütfen hesabı yeniden bağlayın."
      : "Sosyal hesabın platform kimliği (externalId) eksik.";
    await deps.api.client.workerSchedules.outcome(
      scheduleId,
      { status: "failed", attempt: 1, error: msg, accountNeedsReauth: !creds.accessToken },
      init,
    );
    throw new Error(msg);
  }

  const kind = selectPublishKind(
    creds.schedule.platform,
    creds.content.type,
    creds.version.slides.length,
  );
  const prepared = await ensurePreparedMediaForSchedule(creds, kind, deps, signal);

  const nowMs = (deps.now ?? (() => new Date()))().getTime();
  const scheduledMs = Math.max(Date.parse(creds.schedule.scheduledAt), nowMs + 5_000);
  const externalId =
    creds.schedule.platform === "linkedin"
      ? normalizeLinkedInAuthorUrn(creds.account.externalId)
      : creds.account.externalId;

  const mediaDeclarations: CloudOrderMedia[] = prepared.items.map((m) => ({
    id: m.mediaId,
    kind: m.kind,
    mimeType: m.mimeType,
    bytes: m.bytes.byteLength,
    sha256: m.sha256,
    ...(m.width ? { width: m.width } : {}),
    ...(m.height ? { height: m.height } : {}),
    ...(m.durationMs ? { durationMs: m.durationMs, frameRate: 30 } : {}),
  }));

  const orderBody: CloudOrderCreate = {
    contentId: creds.content.id,
    versionId: creds.version.id,
    contentHash: creds.schedule.contentHash,
    scheduledAt: new Date(scheduledMs).toISOString(),
    ...(creds.content.caption ? { caption: creds.content.caption.slice(0, 5000) } : {}),
    ...(creds.content.title ? { title: creds.content.title.slice(0, 255) } : {}),
    ...(hasAiGeneratedMarker(creds) ? { isAiGenerated: true } : {}),
    media: mediaDeclarations,
    targets: [
      {
        id: creds.schedule.id,
        kind,
        accountExternalId: externalId,
        accessToken: creds.accessToken,
      },
    ],
  };

  const orderUrl = `${cloud.url}/v1/orders/${encodeURIComponent(scheduleId)}`;
  const putOrderRes = await doFetch(orderUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${cloud.token}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(orderBody),
    signal,
  });

  if (putOrderRes.status === 409) {
    // A retried schedule whose earlier order failed there: a cloud publisher that cannot
    // replace failed orders yet refuses it. Say so instead of treating it as started.
    if (await everyTargetFailed(doFetch, orderUrl, cloud.token, signal)) {
      throw new Error(
        "Bulut yayıncı başarısız olan siparişi yeniden denemeye izin vermedi; bulut yayıncının güncellenmesi gerekiyor.",
      );
    }
    // Publishing already started (or the order was cancelled there): nothing to replace.
    return {
      orderId: scheduleId,
      mediaUploaded: 0,
      status: "started",
      key: pushKey(creds.schedule),
    };
  }
  if (!putOrderRes.ok) {
    const raw = redactToken(
      await putOrderRes.text().catch(() => ""),
      cloud.token,
      creds.accessToken,
    );
    throw new Error(
      `Bulut yayıncı siparişi reddetti (HTTP ${putOrderRes.status}): ${cloudErrorText(raw)}`,
    );
  }

  let uploadedCount = 0;
  for (const m of prepared.items) {
    const mediaUrl = `${orderUrl}/media/${encodeURIComponent(m.mediaId)}`;
    const putMediaRes = await doFetch(mediaUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${cloud.token}`,
        "content-type": m.mimeType,
      },
      body: m.bytes.slice(),
      signal,
    });
    if (!putMediaRes.ok) {
      const raw = redactToken(await putMediaRes.text().catch(() => ""), cloud.token);
      throw new Error(
        `Cloud Publisher medya yükleme hatası (${m.mediaId}, HTTP ${putMediaRes.status}): ${raw.slice(0, 300)}`,
      );
    }
    uploadedCount++;
  }

  return {
    orderId: scheduleId,
    mediaUploaded: uploadedCount,
    status: "scheduled",
    key: pushKey(creds.schedule),
  };
}

/** True when the cloud order exists and every target of it failed (nothing published). */
async function everyTargetFailed(
  doFetch: typeof fetch,
  orderUrl: string,
  token: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const res = await doFetch(orderUrl, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal,
    });
    if (!res.ok) return false;
    const order = (await res.json()) as { targets?: { status?: string }[] };
    const targets = order.targets ?? [];
    return targets.length > 0 && targets.every((t) => t.status === "failed");
  } catch {
    return false;
  }
}

/** Cancel orders of schedules cancelled on the Mac after they reached the cloud. */
export async function cancelCloudOrders(input: {
  cloud: CloudPublisherConfig;
  deps: SchedulePublishDeps;
  signal: AbortSignal;
}): Promise<number> {
  const { cloud, deps, signal } = input;
  const doFetch = deps.publisherFetch ?? globalThis.fetch.bind(globalThis);
  let list: { items: { id: string }[] };
  try {
    list = await deps.api.client.workerSchedules.cancelled({ limit: 100 }, { signal });
  } catch {
    return 0;
  }
  let cancelled = 0;
  for (const sched of list.items) {
    if (signal.aborted) break;
    const res = await doFetch(`${cloud.url}/v1/orders/${encodeURIComponent(sched.id)}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${cloud.token}`, accept: "application/json" },
      signal,
    });
    // 404: never fully created there; 409: already publishing (too late to stop).
    if (res.ok || res.status === 404 || res.status === 409) {
      cloudState(deps).pushed.delete(sched.id);
      await reportDelivery(
        deps,
        sched.id,
        {
          delivery: "cloud",
          cloudSyncedAt: null,
          ...(res.status === 409
            ? { error: "Bulut yayıncı yayına başlamıştı; iptal edilemedi." }
            : {}),
        },
        signal,
      );
      cancelled++;
    }
  }
  return cancelled;
}

/**
 * Poll `GET ${cloud.url}/v1/orders?updatedSince=...` and write `publishing` / `published` /
 * `failed` outcomes back to the local Studio API via `workerSchedules.outcome`.
 */
export async function syncCloudPublisherOutcomes(input: {
  cloud: CloudPublisherConfig;
  deps: SchedulePublishDeps;
  updatedSince?: string | undefined;
  reportedStates?: Map<string, string>;
  signal: AbortSignal;
}): Promise<{ synced: number; latestUpdatedAt: string | undefined }> {
  const doFetch = input.deps.publisherFetch ?? globalThis.fetch.bind(globalThis);
  let cursor: string | undefined;
  let synced = 0;
  let latestUpdatedAt = input.updatedSince;

  do {
    const params = new URLSearchParams({ limit: "50" });
    if (input.updatedSince) params.set("updatedSince", input.updatedSince);
    if (cursor) params.set("cursor", cursor);
    const res = await doFetch(`${input.cloud.url}/v1/orders?${params.toString()}`, {
      headers: {
        authorization: `Bearer ${input.cloud.token}`,
        accept: "application/json",
      },
      signal: input.signal,
    });
    if (!res.ok) {
      const raw = redactToken(await res.text().catch(() => ""), input.cloud.token);
      throw new Error(
        `Cloud Publisher durum okuma hatası (HTTP ${res.status}): ${raw.slice(0, 240)}`,
      );
    }

    const page = CloudOrderList.parse(await res.json());
    for (const order of page.items) {
      if (!latestUpdatedAt || order.updatedAt > latestUpdatedAt) {
        latestUpdatedAt = order.updatedAt;
      }
      for (const target of order.targets) {
        const stateKey = `${target.status}:${target.attempts}:${target.permalink ?? ""}`;
        if (input.reportedStates?.get(target.id) === stateKey) continue;

        if (target.status === "publishing") {
          await input.deps.api.client.workerSchedules
            .outcome(
              target.id,
              { status: "publishing", attempt: Math.max(1, target.attempts) },
              { signal: input.signal },
            )
            .catch(() => undefined);
          input.reportedStates?.set(target.id, stateKey);
          synced++;
        } else if (target.status === "published") {
          await input.deps.api.client.workerSchedules
            .outcome(
              target.id,
              {
                status: "published",
                attempt: Math.max(1, target.attempts),
                externalPostId: target.postId ?? target.externalId,
                permalink: target.permalink,
              },
              { signal: input.signal },
            )
            .catch(() => undefined);
          input.reportedStates?.set(target.id, stateKey);
          synced++;
        } else if (target.status === "failed") {
          await input.deps.api.client.workerSchedules
            .outcome(
              target.id,
              {
                status: "failed",
                attempt: Math.max(1, target.attempts),
                error: target.error?.message ?? "Bulut yayıncı hatası.",
                accountNeedsReauth: target.error?.action === "reauth",
              },
              { signal: input.signal },
            )
            .catch(() => undefined);
          input.reportedStates?.set(target.id, stateKey);
          synced++;
        }
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return { synced, latestUpdatedAt };
}

function buildLocalPublishRequest(
  creds: WorkerScheduleCredentials,
  kind: CloudPublishKind,
  prepared: { items: PreparedMediaAsset[]; coverAssetId?: string },
  assetContentUrl: (assetId: string) => string,
): PublishRequest {
  const caption = creds.content.caption || undefined;
  const title = creds.content.title || "Gönderi";
  const isAiGenerated = hasAiGeneratedMarker(creds) ? true : undefined;
  const externalId = creds.account.externalId ?? "";

  const toImageMedia = (m: PreparedMediaAsset) => ({
    kind: "image" as const,
    url: assetContentUrl(m.assetId),
    mimeType: m.mimeType,
    bytes: m.bytes.byteLength,
    ...(m.width ? { width: m.width } : {}),
    ...(m.height ? { height: m.height } : {}),
  });

  switch (kind) {
    case "instagram.image":
      return {
        kind,
        igUserId: externalId,
        image: toImageMedia(prepared.items[0] as PreparedMediaAsset),
        ...(caption ? { caption } : {}),
        ...(isAiGenerated ? { isAiGenerated } : {}),
      };
    case "instagram.carousel":
      return {
        kind,
        igUserId: externalId,
        items: prepared.items.map(toImageMedia),
        ...(caption ? { caption } : {}),
        ...(isAiGenerated ? { isAiGenerated } : {}),
      };
    case "instagram.story":
      return {
        kind,
        igUserId: externalId,
        media: toImageMedia(prepared.items[0] as PreparedMediaAsset),
        ...(isAiGenerated ? { isAiGenerated } : {}),
      };
    case "instagram.reel": {
      const v = prepared.items[0] as PreparedMediaAsset;
      return {
        kind,
        igUserId: externalId,
        video: {
          kind: "video",
          source: { type: "upload", key: v.assetId },
          bytes: v.bytes.byteLength,
          mimeType: v.mimeType,
          width: v.width ?? 1080,
          height: v.height ?? 1920,
          ...(v.durationMs ? { durationMs: v.durationMs } : {}),
          frameRate: 30,
        },
        ...(caption ? { caption } : {}),
        thumbOffsetMs: 500,
        shareToFeed: true,
        ...(isAiGenerated ? { isAiGenerated } : {}),
      };
    }
    case "facebook.photo":
      return {
        kind,
        pageId: externalId,
        image: toImageMedia(prepared.items[0] as PreparedMediaAsset),
        ...(caption ? { caption } : {}),
      };
    case "facebook.multi_photo":
      return {
        kind,
        pageId: externalId,
        images: prepared.items.map(toImageMedia),
        ...(caption ? { message: caption } : {}),
      };
    case "facebook.story":
      return {
        kind,
        pageId: externalId,
        media: toImageMedia(prepared.items[0] as PreparedMediaAsset),
        ...(isAiGenerated ? { isAiGenerated } : {}),
      };
    case "facebook.video":
    case "facebook.reel": {
      const v = prepared.items[0] as PreparedMediaAsset;
      return {
        kind,
        pageId: externalId,
        video: {
          kind: "video",
          source: { type: "upload", key: v.assetId },
          bytes: v.bytes.byteLength,
          mimeType: v.mimeType,
          width: v.width ?? 1080,
          height: v.height ?? 1920,
          ...(v.durationMs ? { durationMs: v.durationMs } : {}),
          frameRate: 30,
        },
        title,
        ...(caption ? { description: caption } : {}),
        ...(kind === "facebook.reel" && isAiGenerated ? { isAiGenerated } : {}),
      };
    }
    case "linkedin.text":
      return {
        kind,
        authorUrn: normalizeLinkedInAuthorUrn(externalId),
        commentary: caption || title,
      };
    case "linkedin.image":
      return {
        kind,
        authorUrn: normalizeLinkedInAuthorUrn(externalId),
        image: toImageMedia(prepared.items[0] as PreparedMediaAsset),
        ...(caption ? { commentary: caption } : {}),
      };
    case "linkedin.multi_image":
      return {
        kind,
        authorUrn: normalizeLinkedInAuthorUrn(externalId),
        images: prepared.items.map(toImageMedia),
        ...(caption ? { commentary: caption } : {}),
      };
    case "linkedin.document": {
      const doc = prepared.items[0] as PreparedMediaAsset;
      return {
        kind,
        authorUrn: normalizeLinkedInAuthorUrn(externalId),
        document: {
          kind: "document",
          source: { type: "upload", key: doc.assetId },
          bytes: doc.bytes.byteLength,
          mimeType: "application/pdf",
          title,
        },
        title,
        ...(caption ? { commentary: caption } : {}),
      };
    }
    case "linkedin.video": {
      const v = prepared.items[0] as PreparedMediaAsset;
      return {
        kind,
        authorUrn: normalizeLinkedInAuthorUrn(externalId),
        video: {
          kind: "video",
          source: { type: "upload", key: v.assetId },
          bytes: v.bytes.byteLength,
          mimeType: v.mimeType,
          width: v.width ?? 1080,
          height: v.height ?? 1920,
          ...(v.durationMs ? { durationMs: v.durationMs } : {}),
          frameRate: 30,
        },
        title,
        ...(caption ? { commentary: caption } : {}),
      };
    }
  }
}

/**
 * Mode B: Execute a due schedule directly from the Mac worker using `@studio/publishers`.
 */
export async function publishScheduleLocally(input: {
  scheduleId: string;
  attempt?: number;
  deps: SchedulePublishDeps;
  signal: AbortSignal;
  progress?: (value: number, message: string) => void;
}): Promise<{
  scheduleId: string;
  status: "published";
  platform: string;
  kind: CloudPublishKind;
  externalPostId: string | null;
  permalink: string | null;
}> {
  const { scheduleId, deps, signal } = input;
  const attempt = input.attempt ?? 1;
  const progress = input.progress ?? (() => {});
  const init = { signal };

  let creds: WorkerScheduleCredentials;
  try {
    creds = await deps.api.client.workerSchedules.credentials(scheduleId, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      const msg = "İçerik onayı değiştiği için zamanlanmış yayın iptal edildi.";
      await deps.api.client.workerSchedules
        .outcome(
          scheduleId,
          { status: "failed", attempt, error: msg, accountNeedsReauth: false },
          init,
        )
        .catch(() => undefined);
      throw new Error(msg);
    }
    throw err;
  }

  if (!creds.accessToken) {
    const msg = "Sosyal hesap erişim anahtarı bulunamadı; lütfen hesabı yeniden bağlayın.";
    await deps.api.client.workerSchedules.outcome(
      scheduleId,
      { status: "failed", attempt, error: msg, accountNeedsReauth: true },
      init,
    );
    throw new Error(msg);
  }

  if (!creds.account.externalId) {
    const msg = "Sosyal hesabın platform kimliği (externalId) eksik; hesabı yeniden bağlayın.";
    await deps.api.client.workerSchedules.outcome(
      scheduleId,
      { status: "failed", attempt, error: msg, accountNeedsReauth: true },
      init,
    );
    throw new Error(msg);
  }

  await reportDelivery(deps, scheduleId, { delivery: "local", cloudSyncedAt: null }, signal);
  progress(0.15, "Medya dosyaları yayına hazırlanıyor");
  const kind = selectPublishKind(
    creds.schedule.platform,
    creds.content.type,
    creds.version.slides.length,
  );
  const prepared = await ensurePreparedMediaForSchedule(creds, kind, deps, signal);

  await deps.api.client.workerSchedules.outcome(
    scheduleId,
    { status: "publishing", attempt },
    init,
  );

  const bytesByAssetId = new Map<string, PreparedMediaAsset>();
  for (const item of prepared.items) {
    bytesByAssetId.set(item.assetId, item);
  }

  const mediaReader: MediaReader = {
    async read(key, range) {
      let bytes = bytesByAssetId.get(key)?.bytes;
      if (!bytes) {
        bytes = (await deps.api.downloadAsset(key, { maxBytes: 95 * 1024 * 1024, signal })).bytes;
      }
      const start = Math.max(0, range.offset);
      const end = range.length !== undefined ? start + range.length : bytes.byteLength;
      return bytes.subarray(start, Math.min(bytes.byteLength, end));
    },
  };

  // Intercept local `/api/assets/<id>/content` fetches (used by LinkedIn image publisher)
  // so local publishing works even when `api.baseUrl` is `http://127.0.0.1:8787`!
  const baseFetch = deps.publisherFetch ?? globalThis.fetch.bind(globalThis);
  const wrappedFetch: typeof fetch = async (reqInput, reqInit) => {
    const rawUrl =
      typeof reqInput === "string"
        ? reqInput
        : reqInput instanceof URL
          ? reqInput.toString()
          : reqInput.url;
    const prefix = `${deps.api.baseUrl}/api/assets/`;
    if (rawUrl.startsWith(prefix) && rawUrl.endsWith("/content")) {
      const idPart = decodeURIComponent(
        rawUrl.slice(prefix.length, rawUrl.length - "/content".length),
      );
      const cached = bytesByAssetId.get(idPart);
      if (cached) {
        return new Response(cached.bytes.slice(), {
          status: 200,
          headers: { "content-type": cached.mimeType },
        });
      }
      const dl = await deps.api.downloadAsset(idPart, { maxBytes: 50 * 1024 * 1024, signal });
      return new Response(dl.bytes.slice(), {
        status: 200,
        headers: { "content-type": dl.contentType },
      });
    }
    return baseFetch(reqInput, { ...reqInit, ...(signal ? { signal } : {}) });
  };

  const publisher = createPublisher({
    fetch: wrappedFetch,
    clock: { now: () => (deps.now ?? (() => new Date()))().getTime() },
    ...(deps.publisherMachineOptions ? { machine: deps.publisherMachineOptions } : {}),
  });

  const request = buildLocalPublishRequest(creds, kind, prepared, (assetId) =>
    deps.api.client.assets.contentUrl(assetId),
  );

  let outcomeRecorded = false;
  try {
    progress(0.45, `${creds.schedule.platform} yayını gönderiliyor (${kind})`);
    const initial = publisher.start(request);
    const outcome = await runToCompletion(
      publisher,
      initial,
      { accessToken: creds.accessToken, media: mediaReader },
      {
        clock: { now: () => (deps.now ?? (() => new Date()))().getTime() },
        sleep: deps.publisherSleep ?? ((ms) => abortableSleep(ms, signal)),
      },
    );

    if (outcome.status === "done") {
      const externalPostId = outcome.result.postId ?? outcome.result.externalId;
      outcomeRecorded = true;
      await deps.api.client.workerSchedules.outcome(
        scheduleId,
        {
          status: "published",
          attempt,
          externalPostId,
          permalink: outcome.result.permalink,
        },
        init,
      );
      progress(1, "Yayınlandı");
      return {
        scheduleId,
        status: "published",
        platform: creds.schedule.platform,
        kind,
        externalPostId,
        permalink: outcome.result.permalink,
      };
    }

    const err = outcome.status === "failed" ? outcome.error : null;
    const msg = err?.message ?? "Yayın tamamlanamadı.";
    outcomeRecorded = true;
    await deps.api.client.workerSchedules.outcome(
      scheduleId,
      {
        status: "failed",
        attempt,
        error: msg.slice(0, 4000),
        accountNeedsReauth: err?.action === "reauth",
      },
      init,
    );
    throw new Error(msg);
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    if (outcomeRecorded) throw error;
    if (error instanceof PublishError) {
      await deps.api.client.workerSchedules
        .outcome(
          scheduleId,
          {
            status: "failed",
            attempt,
            error: error.data.message.slice(0, 4000),
            accountNeedsReauth: error.data.action === "reauth",
          },
          init,
        )
        .catch(() => undefined);
      throw new Error(error.data.message);
    }
    const mapped = toPublishError(error, [creds.accessToken]);
    await deps.api.client.workerSchedules
      .outcome(
        scheduleId,
        {
          status: "failed",
          attempt,
          error: mapped.message.slice(0, 4000),
          accountNeedsReauth: mapped.action === "reauth",
        },
        init,
      )
      .catch(() => undefined);
    throw error;
  }
}

export function createSchedulePublishHandler(deps: SchedulePublishDeps) {
  return defineHandler({
    payload: SchedulePublishPayload,
    run: async (payload, ctx: JobContext) => {
      const lockSet = deps.inFlightSchedules;
      if (lockSet?.has(payload.scheduleId)) {
        return {
          scheduleId: payload.scheduleId,
          skipped: true,
          reason: "already_in_flight",
        };
      }
      lockSet?.add(payload.scheduleId);
      try {
        const { cloud } = await resolveCloudPublisherConfig(deps, { signal: ctx.signal });
        if (cloud) {
          // With a cloud publisher every schedule goes there (Meta fetches images from its
          // signed public URLs); a due one is sent for a few seconds from now.
          ctx.progress(0.3, "Bulut yayıncıya sipariş aktarılıyor");
          const pushed = await pushScheduleToCloudPublisher({
            scheduleId: payload.scheduleId,
            cloud,
            deps,
            signal: ctx.signal,
          });
          ctx.progress(1, "Bulut yayıncıya aktarıldı");
          return { mode: "cloud", ...pushed };
        }

        const published = await publishScheduleLocally({
          scheduleId: payload.scheduleId,
          attempt: ctx.attempt ?? 1,
          deps,
          signal: ctx.signal,
          progress: (v, m) => ctx.progress(v, m),
        });
        return { mode: "local", ...published };
      } catch (error) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
        if (error instanceof ApiError && (error.status === undefined || error.status >= 500)) {
          throw new RetryableError(error.message);
        }
        throw error;
      } finally {
        lockSet?.delete(payload.scheduleId);
      }
    },
  });
}
