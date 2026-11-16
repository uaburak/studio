import type {
  Asset,
  Brand,
  BrandProfile,
  Content,
  ContentVersion,
  ContentVersionSummary,
  Job,
  JobType,
  PublishLog,
  Schedule,
  SocialAccount,
} from "@studio/contract";
import type * as schema from "./schema.ts";

export type BrandRow = typeof schema.brands.$inferSelect;
export type SocialAccountRow = typeof schema.socialAccounts.$inferSelect;
export type BrandProfileRow = typeof schema.brandProfiles.$inferSelect;
export type AssetRow = typeof schema.assets.$inferSelect;
export type ContentRow = typeof schema.contents.$inferSelect;
export type ContentVersionRow = typeof schema.contentVersions.$inferSelect;
export type SlideRow = typeof schema.contentVersionSlides.$inferSelect;
export type JobRow = typeof schema.jobs.$inferSelect;
export type ScheduleRow = typeof schema.schedules.$inferSelect;
export type PublishLogRow = typeof schema.publishLogs.$inferSelect;

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export function toBrand(r: BrandRow): Brand {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    defaultLanguage: r.defaultLanguage,
    status: r.status,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function toSocialAccount(r: SocialAccountRow): SocialAccount {
  return {
    id: r.id,
    brandId: r.brandId,
    platform: r.platform,
    handle: r.handle,
    externalId: r.externalId,
    status: r.status,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function toBrandProfile(r: BrandProfileRow): BrandProfile {
  return {
    id: r.id,
    brandId: r.brandId,
    version: r.version,
    status: r.status,
    isCurrent: r.isCurrent,
    tokens: r.tokens,
    designRules: r.designRules,
    voice: r.voice,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    approvedAt: isoOrNull(r.approvedAt),
  };
}

export function toAsset(r: AssetRow): Asset {
  return {
    id: r.id,
    brandId: r.brandId,
    kind: r.kind,
    source: r.source,
    objectKey: r.objectKey,
    mimeType: r.mimeType,
    bytes: r.bytes,
    sha256: r.sha256,
    width: r.width,
    height: r.height,
    durationMs: r.durationMs,
    originalFilename: r.originalFilename,
    createdAt: iso(r.createdAt),
  };
}

/** The bits of the current version a Content response carries. */
export interface CurrentVersionRef {
  id: string;
  version: number;
  contentHash: string;
}

export function toContent(r: ContentRow, current: CurrentVersionRef | null): Content {
  return {
    id: r.id,
    brandId: r.brandId,
    type: r.type,
    title: r.title,
    brief: r.brief,
    status: r.status,
    targetPlatforms: r.targetPlatforms,
    caption: r.caption,
    currentVersion: current,
    approval:
      r.approvedVersionId && r.approvedHash && r.approvedAt
        ? {
            versionId: r.approvedVersionId,
            contentHash: r.approvedHash,
            approvedAt: iso(r.approvedAt),
          }
        : null,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function toVersionSummary(r: ContentVersionRow): ContentVersionSummary {
  return {
    id: r.id,
    contentId: r.contentId,
    version: r.version,
    origin: r.origin,
    contentHash: r.contentHash,
    slideCount: r.slideCount,
    note: r.note,
    jobId: r.jobId,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function toVersion(r: ContentVersionRow, slides: SlideRow[]): ContentVersion {
  return {
    ...toVersionSummary(r),
    slides: [...slides]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        html: s.html,
        width: s.width,
        height: s.height,
        renderedAssetId: s.renderedAssetId,
      })),
  };
}

export function toJob(r: JobRow): Job {
  return {
    id: r.id,
    type: r.type as JobType,
    status: r.status,
    payload: r.payload,
    ...(r.brandId ? { brandId: r.brandId } : {}),
    ...(r.contentId ? { contentId: r.contentId } : {}),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    ...(r.startedAt ? { startedAt: iso(r.startedAt) } : {}),
    ...(r.finishedAt ? { finishedAt: iso(r.finishedAt) } : {}),
    ...(r.progress !== null ? { progress: r.progress } : {}),
    ...(r.output ? { output: r.output } : {}),
    ...(r.error !== null ? { error: r.error } : {}),
  };
}

export function toSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    contentId: r.contentId,
    brandId: r.brandId,
    platform: r.platform,
    socialAccountId: r.socialAccountId,
    versionId: r.versionId,
    contentHash: r.contentHash,
    scheduledAt: iso(r.scheduledAt),
    status: r.status,
    cancelledAt: isoOrNull(r.cancelledAt),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function toPublishLog(r: PublishLogRow): PublishLog {
  return {
    id: r.id,
    scheduleId: r.scheduleId,
    attempt: r.attempt,
    status: r.status,
    externalPostId: r.externalPostId,
    error: r.error,
    startedAt: iso(r.startedAt),
    finishedAt: isoOrNull(r.finishedAt),
    createdAt: iso(r.createdAt),
  };
}
