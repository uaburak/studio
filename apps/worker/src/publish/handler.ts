/**
 * `schedule.publish` handler & shared Cloud / Local publishing driver (L2, Faz 3 & Faz 6):
 * - Mode A (Cloud Publisher): pushes orders + SHA-256 verified media to `STUDIO_CLOUD_PUBLISHER_URL`
 *   and syncs `publishing` / `published` (with `permalink`) / `failed` back to `workerSchedules.outcome`.
 * - Mode B (Local Direct Publisher): drives `@studio/publishers` (`instagram.*`, `facebook.*`,
 *   `linkedin.*`, including automatic PDF generation for LinkedIn carousels) using a local
 *   `MediaReader` backed by `StudioApi`, reporting outcomes to `workerSchedules.outcome`.
 *   A schedule is claimed atomically first (cancelled, published, cloud-held, too late or
 *   no-longer-approved schedules are never published) and the state machine's state is saved
 *   before every action, so a crashed or retried publish resumes and reconciles instead of
 *   posting again.
 * - Publish details (N13): first comment, alt texts, location, collaborators, people tags, the
 *   Reels cover and share-to-feed go into both paths as far as the platform supports them
 *   (`resolvePublishDetails`). A Reels cover picture needs a public URL: it rides with the cloud
 *   order; a local publish uses the video's frame instead and says so in a warning.
 */
import { createHash } from "node:crypto";
import {
  ApiError,
  CloudOrder,
  type CloudOrderCreate,
  CloudOrderList,
  type CloudOrderMedia,
  type CloudPublishKind,
  missedScheduleMessage,
  type ResolvedPublishDetails,
  resolvePublishDetails,
  SchedulePublishPayload,
  type ScheduleWarning,
  selectPublishKind as selectKind,
  type WorkerScheduleClaimRefusal,
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
  type PublishState,
  postPublishWarnings,
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

/** The post's publish details for this publish flow (only what the platform supports). */
export function detailsFor(
  creds: WorkerScheduleCredentials,
  kind: CloudPublishKind,
): ResolvedPublishDetails {
  return resolvePublishDetails(
    creds.content.publishDetails ?? null,
    kind,
    creds.version.slides.length,
  );
}

/** A local publish cannot hand Instagram a cover picture (it needs a public URL). */
const LOCAL_COVER_WARNING: ScheduleWarning = {
  code: "REEL_COVER_SKIPPED",
  message:
    "Reels kapak görseli yalnızca bulut yayıncıyla gönderilebiliyor; Mac'ten yayında videonun karesi kullanıldı.",
};

/**
 * The Reels cover picture as a JPEG (Instagram takes JPEG only, at most 8 MB), for a cloud order.
 * Null when the post has none or it cannot be read (the frame is used then).
 */
async function prepareCover(
  kind: CloudPublishKind,
  details: ResolvedPublishDetails,
  deps: SchedulePublishDeps,
  signal: AbortSignal,
): Promise<PreparedMediaAsset | null> {
  if (kind !== "instagram.reel" || details.reelCover?.kind !== "image") return null;
  try {
    const dl = await deps.api.downloadAsset(details.reelCover.assetId, {
      maxBytes: 25 * 1024 * 1024,
      signal,
    });
    const out = await sharp(dl.bytes, { animated: false })
      .resize({ width: 1080, height: 1920, fit: "cover", withoutEnlargement: false })
      .flatten({ background: "#ffffff" })
      .toColorspace("srgb")
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const bytes = new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength);
    if (bytes.byteLength > 8 * 1024 * 1024) return null;
    return {
      assetId: details.reelCover.assetId,
      mediaId: "cover.jpg",
      kind: "image",
      mimeType: "image/jpeg",
      bytes,
      sha256: sha256Hex(bytes),
      width: out.info.width,
      height: out.info.height,
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
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
    await executeContentRender({
      deps,
      brandId: content.brandId,
      contentId: content.id,
      payload: { version: version.version, format: "jpeg" },
      signal,
    });
    // What the API stored on the approved version is what gets published (its renders are
    // frozen once set), not whatever this render produced.
    const stored = await deps.api.client.contents.versions.get(content.id, version.version, {
      signal,
    });
    slideAssetIds = stored.slides.map(
      (s, i) => version.slides[i]?.renderedAssetId ?? s.renderedAssetId,
    );
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
    if (
      !signal.aborted &&
      !(error instanceof ApiError && error.status === 409) &&
      !(error instanceof ScheduleNotPublished)
    ) {
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

const APPROVAL_CHANGED = "İçerik onayı değiştiği için zamanlanmış yayın iptal edildi.";

/**
 * Calls to the cloud publisher give up after this long (media uploads after the longer one):
 * a hung call must not hold the poller's round, and every other schedule with it, forever.
 */
const CLOUD_TIMEOUT_MS = 30_000;
const CLOUD_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const within = (signal: AbortSignal, ms: number) =>
  AbortSignal.any([signal, AbortSignal.timeout(ms)]);

/** The schedule is not to be published (cancelled, published, cloud-held, too late …). */
export class ScheduleNotPublished extends Error {
  override name = "ScheduleNotPublished";
  constructor(
    readonly reason: WorkerScheduleClaimRefusal | "not_publishable",
    message: string,
  ) {
    super(message);
  }
}

/** The publisher state could not be saved: stop without an outcome (the publish resumes later). */
class StateNotSaved extends Error {
  override name = "StateNotSaved";
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
    if (err instanceof ApiError && err.status === 409 && err.code === "hash_mismatch") {
      await deps.api.client.workerSchedules
        .outcome(
          scheduleId,
          {
            status: "failed",
            attempt: 1,
            error: APPROVAL_CHANGED,
            accountNeedsReauth: false,
          },
          init,
        )
        .catch(() => undefined);
    }
    throw err;
  }

  // Too late (S6): the Mac slept through the publish time and it was never handed over.
  const { maxLatenessMs } = await resolveCloudPublisherConfig(deps, { signal });
  const lateMs = nowMs(deps) - Date.parse(creds.schedule.scheduledAt);
  if (lateMs > maxLatenessMs) {
    const msg = missedScheduleMessage(Math.round(maxLatenessMs / 60_000));
    await deps.api.client.workerSchedules.outcome(
      scheduleId,
      { status: "failed", attempt: 1, error: msg, accountNeedsReauth: false },
      init,
    );
    throw new ScheduleNotPublished("missed", msg);
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
  // Preparing media may render (a Reel without its video makes a new version, which revokes
  // the approval and cancels the schedule): make sure it is still the approved, pending one.
  await deps.api.client.workerSchedules.credentials(scheduleId, init);

  const originalMs = Date.parse(creds.schedule.scheduledAt);
  const scheduledMs = Math.max(originalMs, nowMs(deps) + 5_000);
  const externalId =
    creds.schedule.platform === "linkedin"
      ? normalizeLinkedInAuthorUrn(creds.account.externalId)
      : creds.account.externalId;

  const details = detailsFor(creds, kind);
  const cover = await prepareCover(kind, details, deps, signal);
  const pictureTags = kind === "instagram.image" || kind === "instagram.carousel";
  const mediaDeclarations: CloudOrderMedia[] = prepared.items.map((m, i) => {
    const altText = m.kind === "image" ? details.altTexts[i] : undefined;
    const tags = pictureTags && m.kind === "image" ? details.userTags[i] : undefined;
    return {
      id: m.mediaId,
      kind: m.kind,
      mimeType: m.mimeType,
      bytes: m.bytes.byteLength,
      sha256: m.sha256,
      ...(m.width ? { width: m.width } : {}),
      ...(m.height ? { height: m.height } : {}),
      ...(m.durationMs ? { durationMs: m.durationMs, frameRate: 30 } : {}),
      ...(altText ? { altText: altText.slice(0, 1000) } : {}),
      ...(tags?.length ? { userTags: tags } : {}),
    };
  });
  if (cover) {
    mediaDeclarations.push({
      id: cover.mediaId,
      kind: "image",
      mimeType: "image/jpeg",
      bytes: cover.bytes.byteLength,
      sha256: cover.sha256,
      ...(cover.width ? { width: cover.width } : {}),
      ...(cover.height ? { height: cover.height } : {}),
      role: "cover",
    });
  }
  const reelTags = kind === "instagram.reel" ? (details.userTags[0] ?? []) : [];
  const orderDetails = {
    ...(details.firstComment ? { firstComment: details.firstComment } : {}),
    ...(details.locationId ? { locationId: details.locationId } : {}),
    ...(details.collaborators?.length ? { collaborators: details.collaborators } : {}),
    ...(reelTags.length ? { reelUserTags: reelTags.map((t) => t.username) } : {}),
    ...(details.reelCover?.kind === "frame" ? { thumbOffsetMs: details.reelCover.offsetMs } : {}),
    ...(details.shareToFeed === false ? { shareToFeed: false } : {}),
  };

  const orderBody: CloudOrderCreate = {
    contentId: creds.content.id,
    versionId: creds.version.id,
    contentHash: creds.schedule.contentHash,
    scheduledAt: new Date(scheduledMs).toISOString(),
    // The cloud publisher does not start it later than this (the Mac's maximum lateness).
    notAfter: new Date(Math.max(originalMs + maxLatenessMs, scheduledMs + 60_000)).toISOString(),
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
    ...(Object.keys(orderDetails).length ? { details: orderDetails } : {}),
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
    signal: within(signal, CLOUD_TIMEOUT_MS),
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
  for (const m of cover ? [...prepared.items, cover] : prepared.items) {
    const mediaUrl = `${orderUrl}/media/${encodeURIComponent(m.mediaId)}`;
    const putMediaRes = await doFetch(mediaUrl, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${cloud.token}`,
        "content-type": m.mimeType,
      },
      body: m.bytes.slice(),
      signal: within(signal, CLOUD_UPLOAD_TIMEOUT_MS),
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
      signal: within(signal, CLOUD_TIMEOUT_MS),
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
    const orderUrl = `${cloud.url}/v1/orders/${encodeURIComponent(sched.id)}`;
    const res = await doFetch(`${orderUrl}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${cloud.token}`, accept: "application/json" },
      signal: within(signal, CLOUD_TIMEOUT_MS),
    });
    // 409: it had already started there (too late to stop): record what really happened,
    // so the post does not show as cancelled while it is live.
    if (res.status === 409 && !(await recordCloudTruth(deps, cloud, orderUrl, sched.id, signal))) {
      continue; // could not read it now: try again next round
    }
    // 404: never fully created there.
    if (res.ok || res.status === 404 || res.status === 409) {
      cloudState(deps).pushed.delete(sched.id);
      await reportDelivery(
        deps,
        sched.id,
        {
          delivery: "cloud",
          cloudSyncedAt: null,
          ...(res.status === 409
            ? { error: "Bulut yayıncı iptalden önce yayına başlamıştı; iptal edilemedi." }
            : {}),
        },
        signal,
      );
      cancelled++;
    }
  }
  return cancelled;
}

/** Write a cloud order target's real state back to a schedule cancelled here too late. */
async function recordCloudTruth(
  deps: SchedulePublishDeps,
  cloud: CloudPublisherConfig,
  orderUrl: string,
  scheduleId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const doFetch = deps.publisherFetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await doFetch(orderUrl, {
      headers: { authorization: `Bearer ${cloud.token}`, accept: "application/json" },
      signal: within(signal, CLOUD_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const order = CloudOrder.parse(await res.json());
    const target = order.targets.find((t) => t.id === scheduleId);
    if (!target) return true;
    const attempt = Math.max(1, target.attempts);
    if (target.status === "published") {
      await deps.api.client.workerSchedules.outcome(
        scheduleId,
        {
          status: "published",
          attempt,
          externalPostId: target.postId ?? target.externalId,
          permalink: target.permalink,
        },
        { signal },
      );
    } else if (target.status === "publishing") {
      await deps.api.client.workerSchedules.outcome(
        scheduleId,
        { status: "publishing", attempt },
        { signal },
      );
    } else if (target.status === "failed") {
      await deps.api.client.workerSchedules.outcome(
        scheduleId,
        {
          status: "failed",
          attempt,
          error: target.error?.message ?? "Bulut yayıncı hatası.",
          accountNeedsReauth: target.error?.action === "reauth",
        },
        { signal },
      );
    }
    // Its later outcomes come with the regular sync.
    cloudState(deps).reported.delete(scheduleId);
    return true;
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
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
      signal: within(input.signal, CLOUD_TIMEOUT_MS),
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
                ...(target.warnings?.length ? { warnings: target.warnings.slice(0, 20) } : {}),
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

/** Kind, account and texts of a request: what a resumed state must still match. */
function requestIdentity(request: PublishRequest): string {
  const r = request as Partial<
    Record<
      | "caption"
      | "commentary"
      | "message"
      | "description"
      | "title"
      | "igUserId"
      | "pageId"
      | "authorUrn"
      | "firstComment",
      unknown
    >
  >;
  return JSON.stringify([
    request.kind,
    r.igUserId ?? r.pageId ?? r.authorUrn ?? null,
    r.caption ?? null,
    r.commentary ?? null,
    r.message ?? null,
    r.description ?? null,
    r.title ?? null,
    r.firstComment ?? null,
  ]);
}

export function buildLocalPublishRequest(
  creds: WorkerScheduleCredentials,
  kind: CloudPublishKind,
  prepared: { items: PreparedMediaAsset[]; coverAssetId?: string },
  assetContentUrl: (assetId: string) => string,
): PublishRequest {
  const caption = creds.content.caption || undefined;
  const title = creds.content.title || "Gönderi";
  const isAiGenerated = hasAiGeneratedMarker(creds) ? true : undefined;
  const externalId = creds.account.externalId ?? "";
  const d = detailsFor(creds, kind);
  const comment = d.firstComment ? { firstComment: d.firstComment } : {};
  const ig = {
    ...comment,
    ...(d.collaborators?.length ? { collaborators: d.collaborators } : {}),
    ...(d.locationId ? { locationId: d.locationId } : {}),
  };

  const toImageMedia = (m: PreparedMediaAsset, i = 0, opts: { tags?: boolean } = {}) => ({
    kind: "image" as const,
    url: assetContentUrl(m.assetId),
    mimeType: m.mimeType,
    bytes: m.bytes.byteLength,
    ...(m.width ? { width: m.width } : {}),
    ...(m.height ? { height: m.height } : {}),
    ...(d.altTexts[i] ? { altText: d.altTexts[i] } : {}),
    ...(opts.tags && d.userTags[i]?.length ? { userTags: d.userTags[i] } : {}),
  });

  switch (kind) {
    case "instagram.image":
      return {
        kind,
        igUserId: externalId,
        image: toImageMedia(prepared.items[0] as PreparedMediaAsset),
        ...(caption ? { caption } : {}),
        ...(isAiGenerated ? { isAiGenerated } : {}),
        ...ig,
        ...(d.userTags[0]?.length ? { userTags: d.userTags[0] } : {}),
      };
    case "instagram.carousel":
      return {
        kind,
        igUserId: externalId,
        items: prepared.items.map((m, i) => toImageMedia(m, i, { tags: true })),
        ...(caption ? { caption } : {}),
        ...(isAiGenerated ? { isAiGenerated } : {}),
        ...ig,
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
        thumbOffsetMs: d.reelCover?.kind === "frame" ? d.reelCover.offsetMs : 500,
        shareToFeed: d.shareToFeed ?? true,
        ...(isAiGenerated ? { isAiGenerated } : {}),
        ...ig,
        ...(d.userTags[0]?.length
          ? { userTags: d.userTags[0].map((t) => ({ username: t.username })) }
          : {}),
      };
    }
    case "facebook.photo":
      return {
        kind,
        pageId: externalId,
        image: toImageMedia(prepared.items[0] as PreparedMediaAsset),
        ...(caption ? { caption } : {}),
        ...comment,
      };
    case "facebook.multi_photo":
      return {
        kind,
        pageId: externalId,
        images: prepared.items.map((m, i) => toImageMedia(m, i)),
        ...(caption ? { message: caption } : {}),
        ...comment,
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
        ...comment,
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
        images: prepared.items.map((m, i) => toImageMedia(m, i)),
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

export type LocalPublishResult =
  | {
      scheduleId: string;
      status: "published";
      platform: string;
      kind: CloudPublishKind;
      externalPostId: string | null;
      permalink: string | null;
      resumed: boolean;
    }
  | {
      scheduleId: string;
      status: "skipped";
      reason: WorkerScheduleClaimRefusal | "not_publishable";
      message: string;
    };

const skipped = (scheduleId: string, error: ScheduleNotPublished): LocalPublishResult => ({
  scheduleId,
  status: "skipped",
  reason: error.reason,
  message: error.message,
});

/**
 * Mode B: Execute a due schedule directly from the Mac worker using `@studio/publishers`.
 *
 * 1. Credentials: refused (409) for a schedule that is not pending/publishing or whose
 *    approval changed.
 * 2. Media is prepared (renders) before the claim, so a render that loses the approval
 *    cancels the schedule and the claim refuses it.
 * 3. The claim moves it to `publishing` atomically (or takes over a stale local claim with
 *    its saved state); a refused claim publishes nothing.
 * 4. Every state machine state is saved (`publish-state`) before it is acted on; a resumed
 *    state reconciles with the platform before any publish call.
 * 5. The outcome is a compare-and-set on the API side.
 */
export async function publishScheduleLocally(input: {
  scheduleId: string;
  attempt?: number;
  deps: SchedulePublishDeps;
  signal: AbortSignal;
  progress?: (value: number, message: string) => void;
}): Promise<LocalPublishResult> {
  const { scheduleId, deps, signal } = input;
  const progress = input.progress ?? (() => {});
  const init = { signal };

  let creds: WorkerScheduleCredentials;
  try {
    creds = await deps.api.client.workerSchedules.credentials(scheduleId, init);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.code === "invalid_transition") {
      // Cancelled, published or failed meanwhile: nothing to publish.
      return skipped(scheduleId, new ScheduleNotPublished("not_publishable", err.message));
    }
    if (err instanceof ApiError && err.status === 409) {
      await deps.api.client.workerSchedules
        .outcome(
          scheduleId,
          { status: "failed", attempt: input.attempt ?? 1, error: APPROVAL_CHANGED },
          init,
        )
        .catch(() => undefined);
      throw new Error(APPROVAL_CHANGED);
    }
    throw err;
  }

  const fail = async (msg: string, reauth: boolean, attempt: number) => {
    await deps.api.client.workerSchedules
      .outcome(
        scheduleId,
        { status: "failed", attempt, error: msg, accountNeedsReauth: reauth },
        init,
      )
      .catch(() => undefined);
    throw new Error(msg);
  };
  if (!creds.accessToken) {
    return fail(
      "Sosyal hesap erişim anahtarı bulunamadı; lütfen hesabı yeniden bağlayın.",
      true,
      input.attempt ?? 1,
    );
  }
  if (!creds.account.externalId) {
    return fail(
      "Sosyal hesabın platform kimliği (externalId) eksik; hesabı yeniden bağlayın.",
      true,
      input.attempt ?? 1,
    );
  }
  const accessToken = creds.accessToken;

  const kind = selectPublishKind(
    creds.schedule.platform,
    creds.content.type,
    creds.version.slides.length,
  );
  let prepared: { items: PreparedMediaAsset[]; coverAssetId?: string } | null = null;
  if (creds.schedule.status === "pending") {
    progress(0.15, "Medya dosyaları yayına hazırlanıyor");
    prepared = await ensurePreparedMediaForSchedule(creds, kind, deps, signal);
  }

  const claim = await deps.api.client.workerSchedules.claim(
    scheduleId,
    { attempt: input.attempt ?? 1 },
    init,
  );
  if (!claim.claimed) {
    const reason = claim.reason ?? "in_progress";
    const message =
      reason === "missed"
        ? (claim.schedule.lastError ?? "Paylaşım saati çok geçti.")
        : `Zamanlama paylaşılmadı (${reason}).`;
    return skipped(scheduleId, new ScheduleNotPublished(reason, message));
  }
  const attempt = claim.attempt;

  // A saved state resumes (and reconciles) unless it ended in a definitive failure (nothing
  // was published then; start again from scratch).
  let saved = claim.publishState as PublishState | null;
  if (saved && saved.phase === "failed") saved = null;
  if (saved && !claim.resumed && prepared) {
    // A retried failed schedule kept the state of its earlier try (same design). Its caption
    // may have changed since (that needs a new approval but not a new design): resume only
    // when the text and the account are still the same, otherwise start from scratch.
    const fresh = buildLocalPublishRequest(creds, kind, prepared, (assetId) =>
      deps.api.client.assets.contentUrl(assetId),
    );
    if (requestIdentity(saved.request) !== requestIdentity(fresh)) saved = null;
  }
  if (saved && saved.intentAt === null) {
    // Nothing reached the platform yet: a late resume is a late publish (S6).
    const { maxLatenessMs } = await resolveCloudPublisherConfig(deps, { signal });
    if (nowMs(deps) - Date.parse(creds.schedule.scheduledAt) > maxLatenessMs) {
      const msg = missedScheduleMessage(Math.round(maxLatenessMs / 60_000));
      await deps.api.client.workerSchedules.outcome(
        scheduleId,
        { status: "failed", attempt, error: msg },
        init,
      );
      return skipped(scheduleId, new ScheduleNotPublished("missed", msg));
    }
  }

  if (!saved && !prepared) {
    // A stale claim without a saved state: nothing was sent; prepare and check approval again.
    prepared = await ensurePreparedMediaForSchedule(creds, kind, deps, signal);
    try {
      await deps.api.client.workerSchedules.credentials(scheduleId, init);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        return fail(APPROVAL_CHANGED, false, attempt);
      }
      throw err;
    }
  }

  const bytesByAssetId = new Map<string, PreparedMediaAsset>();
  for (const item of prepared?.items ?? []) {
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
    return baseFetch(reqInput, {
      ...reqInit,
      // The caller's own timeout stays; the job's abort signal joins it.
      signal: reqInit?.signal ? AbortSignal.any([reqInit.signal, signal]) : signal,
    });
  };

  const linkedinVersion = deps.settings.parentEnv.STUDIO_LINKEDIN_VERSION?.trim();
  const publisher = createPublisher({
    fetch: wrappedFetch,
    clock: { now: () => nowMs(deps) },
    ...(linkedinVersion ? { linkedinVersion } : {}),
    ...(deps.publisherMachineOptions ? { machine: deps.publisherMachineOptions } : {}),
  });

  /** Save the state before acting on it; a failed save stops the run (it resumes later). */
  const persist = async (state: PublishState) => {
    try {
      await deps.api.client.workerSchedules.publishState(
        scheduleId,
        { state: state as unknown as Record<string, unknown> },
        init,
      );
    } catch (error) {
      if (signal.aborted) throw error;
      throw new StateNotSaved(
        `Yayın durumu kaydedilemedi (${(error as Error).message}); yayın daha sonra kaldığı yerden sürecek.`,
      );
    }
  };

  let outcomeRecorded = false;
  try {
    let initial: PublishState;
    if (saved) {
      initial = saved;
      progress(0.45, `${creds.schedule.platform} yayını kaldığı yerden sürüyor (${kind})`);
    } else {
      const request = buildLocalPublishRequest(creds, kind, prepared ?? { items: [] }, (assetId) =>
        deps.api.client.assets.contentUrl(assetId),
      );
      initial = publisher.start(request);
      await persist(initial);
      progress(0.45, `${creds.schedule.platform} yayını gönderiliyor (${kind})`);
    }
    const outcome = await runToCompletion(
      publisher,
      initial,
      { accessToken, media: mediaReader },
      {
        clock: { now: () => nowMs(deps) },
        sleep: deps.publisherSleep ?? ((ms) => abortableSleep(ms, signal)),
        onState: (state) => persist(state),
      },
    );

    if (outcome.status === "done") {
      const externalPostId = outcome.result.postId ?? outcome.result.externalId;
      const warnings: ScheduleWarning[] = postPublishWarnings(outcome.result.warnings);
      if (kind === "instagram.reel" && detailsFor(creds, kind).reelCover?.kind === "image")
        warnings.push(LOCAL_COVER_WARNING);
      outcomeRecorded = true;
      await deps.api.client.workerSchedules.outcome(
        scheduleId,
        {
          status: "published",
          attempt,
          externalPostId,
          permalink: outcome.result.permalink,
          ...(warnings.length ? { warnings } : {}),
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
        resumed: saved !== null,
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
    // Mid-publish and the state could not be saved: leave it `publishing`; the stale-claim
    // sweep resumes it from the last saved state (which reconciles first).
    if (outcomeRecorded || error instanceof StateNotSaved) throw error;
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
    const mapped = toPublishError(error, [accessToken]);
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
        const { cloud, unavailable } = await resolveCloudPublisherConfig(deps, {
          signal: ctx.signal,
        });
        // Unknown publishing path (unreadable cloud token): publishing locally could post what
        // the cloud publisher also holds. Retry later instead.
        if (unavailable) throw new RetryableError(unavailable);
        if (cloud) {
          // With a cloud publisher every schedule goes there (Meta fetches images from its
          // signed public URLs); a due one is sent for a few seconds from now.
          ctx.progress(0.3, "Bulut yayıncıya sipariş aktarılıyor");
          try {
            const pushed = await pushScheduleToCloudPublisher({
              scheduleId: payload.scheduleId,
              cloud,
              deps,
              signal: ctx.signal,
            });
            ctx.progress(1, "Bulut yayıncıya aktarıldı");
            return { mode: "cloud", ...pushed };
          } catch (error) {
            if (error instanceof ScheduleNotPublished) {
              return {
                mode: "cloud",
                scheduleId: payload.scheduleId,
                skipped: true,
                reason: error.reason,
                message: error.message,
              };
            }
            if (
              error instanceof ApiError &&
              error.status === 409 &&
              error.code === "invalid_transition"
            ) {
              // Cancelled, published or failed meanwhile: nothing to hand over.
              return {
                mode: "cloud",
                scheduleId: payload.scheduleId,
                skipped: true,
                reason: "not_publishable",
                message: error.message,
              };
            }
            throw error;
          }
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
