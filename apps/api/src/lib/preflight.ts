/**
 * Platform rules before scheduling (P3).
 *
 * Builds the request the worker will build at publish time (same publish kind,
 * same media order) from what the API knows — slide sizes, rendered asset
 * metadata, the caption, Reels metadata in the slide — and runs the publishers'
 * `validateRequest`. Instagram images are always sent as JPEG (the worker converts),
 * so their mime type is not held against the content here.
 */
import {
  type PreflightIssue,
  PUBLIC_URL_PUBLISH_KINDS,
  type PublishingMode,
  type PublishKindName,
  type SchedulePreflightTarget,
  selectPublishKind,
} from "@studio/contract";
import { FACEBOOK_LIMITS, validateRequest } from "@studio/publishers";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  assets,
  contents,
  schedules,
  type socialAccounts,
  type socialAccountTokens,
} from "../db/schema.ts";

type AccountRow = typeof socialAccounts.$inferSelect;
type TokenRow = typeof socialAccountTokens.$inferSelect;

export interface PreflightSlide {
  html: string;
  width: number;
  height: number;
  renderedAssetId: string | null;
}

export interface PreflightContent {
  type: "post" | "carousel" | "story" | "reel";
  title: string;
  caption: string | null;
  slides: PreflightSlide[];
}

const FAKE_ORIGIN = "https://media.studio.invalid";

function attr(html: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]+)"`, "i").exec(html);
  return m?.[1] ?? null;
}

interface AssetMeta {
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
}

async function loadAssetMeta(db: Db, ids: string[]): Promise<Map<string, AssetMeta>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: assets.id,
      mimeType: assets.mimeType,
      bytes: assets.bytes,
      width: assets.width,
      height: assets.height,
      durationMs: assets.durationMs,
    })
    .from(assets)
    .where(inArray(assets.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

function buildRequest(
  kind: PublishKindName,
  content: PreflightContent,
  externalId: string,
  meta: Map<string, AssetMeta>,
): unknown {
  const caption = content.caption?.trim() || undefined;
  const isInstagram = kind.startsWith("instagram.");
  const image = (slide: PreflightSlide, i: number) => {
    const m = slide.renderedAssetId ? meta.get(slide.renderedAssetId) : undefined;
    // The worker sends Instagram slides as JPEG (converting PNG), other platforms as rendered.
    const mimeType = isInstagram ? "image/jpeg" : (m?.mimeType ?? "image/jpeg");
    return {
      kind: "image" as const,
      url: `${FAKE_ORIGIN}/slide-${i + 1}.${mimeType === "image/png" ? "png" : "jpg"}`,
      mimeType,
      width: m?.width ?? slide.width,
      height: m?.height ?? slide.height,
      ...(m && !(isInstagram && m.mimeType !== "image/jpeg") ? { bytes: m.bytes } : {}),
    };
  };
  const video = () => {
    const html = content.slides[0]?.html ?? "";
    const videoId = attr(html, "data-video-asset-id");
    const m = videoId ? meta.get(videoId) : undefined;
    const durationRaw = attr(html, "data-duration-ms");
    const durationMs =
      m?.durationMs ?? (durationRaw && /^\d+$/.test(durationRaw) ? Number(durationRaw) : undefined);
    return {
      kind: "video" as const,
      source: { type: "url" as const, url: `${FAKE_ORIGIN}/reel.mp4` },
      mimeType: m?.mimeType ?? "video/mp4",
      width: m?.width ?? 1080,
      height: m?.height ?? 1920,
      ...(m ? { bytes: m.bytes } : {}),
      ...(durationMs ? { durationMs } : {}),
      frameRate: 30,
    };
  };
  const images = content.slides.map(image);
  const first =
    images[0] ?? image({ html: "", width: 1080, height: 1350, renderedAssetId: null }, 0);
  const authorUrn = /^urn:li:/.test(externalId) ? externalId : `urn:li:person:${externalId || "x"}`;
  switch (kind) {
    case "instagram.image":
      return { kind, igUserId: externalId, image: first, ...(caption ? { caption } : {}) };
    case "instagram.carousel":
      return { kind, igUserId: externalId, items: images, ...(caption ? { caption } : {}) };
    case "instagram.story":
      return { kind, igUserId: externalId, media: first };
    case "instagram.reel":
      return { kind, igUserId: externalId, video: video(), ...(caption ? { caption } : {}) };
    case "facebook.photo":
      return { kind, pageId: externalId, image: first, ...(caption ? { caption } : {}) };
    case "facebook.multi_photo":
      return { kind, pageId: externalId, images, ...(caption ? { message: caption } : {}) };
    case "facebook.story":
      return { kind, pageId: externalId, media: first };
    case "facebook.video":
    case "facebook.reel":
      return {
        kind,
        pageId: externalId,
        video: video(),
        title: content.title || "Gönderi",
        ...(caption ? { description: caption } : {}),
      };
    case "linkedin.text":
      return { kind, authorUrn, commentary: caption ?? content.title };
    case "linkedin.image":
      return { kind, authorUrn, image: first, ...(caption ? { commentary: caption } : {}) };
    case "linkedin.multi_image":
      return { kind, authorUrn, images, ...(caption ? { commentary: caption } : {}) };
    case "linkedin.document":
      return {
        kind,
        authorUrn,
        document: {
          kind: "document",
          source: { type: "url", url: `${FAKE_ORIGIN}/carousel.pdf` },
          mimeType: "application/pdf",
          title: content.title || "Belge",
        },
        title: content.title || "Belge",
        ...(caption ? { commentary: caption } : {}),
      };
    case "linkedin.video":
      return {
        kind,
        authorUrn,
        video: video(),
        title: content.title || "Video",
        ...(caption ? { commentary: caption } : {}),
      };
  }
}

/** Warnings that only exist because the API does not have the final file. */
const NOISE = new Set(["METADATA_MISSING", "IMAGE_WILL_BE_RESCALED"]);

const DAY_MS = 24 * 3600_000;

/**
 * The most items any 24-hour window containing `at` would hold with one more item at `at`,
 * given the other items' times. Facebook counts Reels per Page in a rolling 24 hours.
 */
export function busiestDayWith(times: readonly number[], at: number): number {
  const near = times.filter((t) => t > at - DAY_MS && t < at + DAY_MS).sort((a, b) => a - b);
  // A window [w, w + 24h) holds `at` when w is in (at - 24h, at]; the fullest one starts at an item.
  const starts = [...near.filter((t) => t <= at), at];
  let best = 0;
  for (const w of starts) {
    const count = near.filter((t) => t >= w && t < w + DAY_MS).length;
    best = Math.max(best, count + 1);
  }
  return best;
}

/** Times of the Page's Facebook Reels around `at` that are planned, publishing or published. */
async function facebookReelTimes(db: Db, socialAccountId: string, at: number): Promise<number[]> {
  const rows = await db
    .select({ scheduledAt: schedules.scheduledAt })
    .from(schedules)
    .innerJoin(contents, eq(schedules.contentId, contents.id))
    .where(
      and(
        eq(schedules.socialAccountId, socialAccountId),
        eq(schedules.platform, "facebook"),
        eq(contents.type, "reel"),
        inArray(schedules.status, ["pending", "publishing", "published"]),
        gt(schedules.scheduledAt, new Date(at - DAY_MS)),
        lt(schedules.scheduledAt, new Date(at + DAY_MS)),
      ),
    );
  // A failed schedule does not count: a retry reuses it.
  return rows.map((r) => r.scheduledAt.getTime());
}

export async function preflightTargets(args: {
  db: Db;
  content: PreflightContent;
  accounts: { account: AccountRow; token: TokenRow | null }[];
  mode: PublishingMode;
  allowPrivateMedia: boolean;
  now?: number;
  /** Planned publish time (per-day limits); default `now`. */
  scheduledAt?: number;
}): Promise<SchedulePreflightTarget[]> {
  const now = args.now ?? Date.now();
  const at = args.scheduledAt ?? now;
  const ids: string[] = [];
  for (const s of args.content.slides) {
    if (s.renderedAssetId) ids.push(s.renderedAssetId);
  }
  const videoId = attr(args.content.slides[0]?.html ?? "", "data-video-asset-id");
  if (videoId) ids.push(videoId);
  const meta = await loadAssetMeta(args.db, ids);

  const reelTimes = new Map<string, number[]>();
  for (const { account } of args.accounts) {
    if (
      selectPublishKind(account.platform, args.content.type, args.content.slides.length) !==
      "facebook.reel"
    )
      continue;
    reelTimes.set(account.id, await facebookReelTimes(args.db, account.id, at));
  }

  return args.accounts.map(({ account, token }) => {
    const kind = selectPublishKind(account.platform, args.content.type, args.content.slides.length);
    const errors: PreflightIssue[] = [];
    const warnings: PreflightIssue[] = [];

    const report = validateRequest(
      buildRequest(kind, args.content, account.externalId ?? "0", meta),
    );
    for (const issue of report.errors) {
      // The synthetic request has placeholder ids/URLs; schema problems there are ours, not the owner's.
      if (issue.code === "SCHEMA_INVALID" && /igUserId|pageId|authorUrn|url/.test(issue.path))
        continue;
      errors.push({ code: issue.code, path: issue.path, message: issue.message });
    }
    for (const issue of report.warnings) {
      if (NOISE.has(issue.code)) continue;
      warnings.push({ code: issue.code, path: issue.path, message: issue.message });
    }

    if (
      args.mode === "local" &&
      !args.allowPrivateMedia &&
      PUBLIC_URL_PUBLISH_KINDS.includes(kind)
    ) {
      errors.push({
        code: "LOCAL_MEDIA_NOT_PUBLIC",
        path: "",
        message:
          `${account.platform === "instagram" ? "Instagram" : "Facebook"} görseli herkese açık bir adresten indirir; ` +
          "bu Mac'in adresine dışarıdan ulaşılamaz. Bu yayın için Ayarlar → Yayın'da bulut yayıncıyı kurun.",
      });
    }

    const reels = reelTimes.get(account.id);
    if (reels && busiestDayWith(reels, at) > FACEBOOK_LIMITS.reel.maxPerDay) {
      errors.push({
        code: "FB_REELS_DAILY_LIMIT",
        path: "",
        message:
          `Facebook bir sayfada 24 saat içinde en fazla ${FACEBOOK_LIMITS.reel.maxPerDay} Reels yayınlatır; ` +
          "bu sayfada o saatlere yakın zaten bu kadar Reels var. Başka bir gün ya da saat seçin.",
      });
    }

    if (account.status === "disabled") {
      errors.push({
        code: "ACCOUNT_DISABLED",
        path: "",
        message: "Bu hesabın bağlantısı kesilmiş.",
      });
    } else if (!token || account.status === "needs_reauth" || token.health === "invalid") {
      warnings.push({
        code: "ACCOUNT_NEEDS_REAUTH",
        path: "",
        message:
          "Hesabın erişim anahtarı yok ya da geçersiz; yayından önce hesabı yeniden bağlayın.",
      });
    } else if (token.expiresAt && token.expiresAt.getTime() - now < 7 * 24 * 3600_000) {
      warnings.push({
        code: "TOKEN_EXPIRING",
        path: "",
        message: "Hesabın erişim anahtarı yakında doluyor; yeniden bağlamanız önerilir.",
      });
    }

    return {
      socialAccountId: account.id,
      platform: account.platform,
      handle: account.handle,
      kind,
      ok: errors.length === 0,
      errors,
      warnings,
    };
  });
}
