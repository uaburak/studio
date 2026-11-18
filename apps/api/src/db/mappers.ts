import {
  type AgentRun,
  type Asset,
  assetContentPath,
  type Brand,
  type BrandCheckSettings,
  type BrandProduct,
  type BrandProfile,
  type CheckCategory,
  type CheckSource,
  type CheckStatus,
  type Content,
  type ContentCheckRun,
  type ContentVersion,
  type ContentVersionSummary,
  type Conversation,
  type ConversationAlias,
  type Job,
  type JobStatus,
  type JobType,
  type Message,
  type MessageMention,
  type MessagePart,
  type Plan,
  type PlanItem,
  PublishDetails,
  type PublishLog,
  type RunUsage,
  type Schedule,
  type SocialAccount,
  type TurnAlias,
} from "@studio/contract";
import type * as schema from "./schema.ts";

export type BrandRow = typeof schema.brands.$inferSelect;
export type SocialAccountRow = typeof schema.socialAccounts.$inferSelect;
export type SocialAccountTokenRow = typeof schema.socialAccountTokens.$inferSelect;
export type BrandProfileRow = typeof schema.brandProfiles.$inferSelect;
export type BrandProductRow = typeof schema.brandProducts.$inferSelect;
export type AssetRow = typeof schema.assets.$inferSelect;
export type ContentRow = typeof schema.contents.$inferSelect;
export type ContentVersionRow = typeof schema.contentVersions.$inferSelect;
export type SlideRow = typeof schema.contentVersionSlides.$inferSelect;
export type JobRow = typeof schema.jobs.$inferSelect;
export type ScheduleRow = typeof schema.schedules.$inferSelect;
export type PublishLogRow = typeof schema.publishLogs.$inferSelect;
export type ConversationRow = typeof schema.conversations.$inferSelect;
export type MessageRow = typeof schema.messages.$inferSelect;
export type AgentRunRow = typeof schema.agentRuns.$inferSelect;
export type ConversationEventRow = typeof schema.conversationEvents.$inferSelect;
export type PlanRow = typeof schema.contentPlans.$inferSelect;
export type PlanItemRow = typeof schema.planItems.$inferSelect;
export type ConversationAliasRow = typeof schema.conversationAliases.$inferSelect;
export type ContentCheckRunRow = typeof schema.contentCheckRuns.$inferSelect;
export type BrandCheckSettingsRow = typeof schema.brandCheckSettings.$inferSelect;

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

export function toSocialAccount(
  r: SocialAccountRow,
  token?: SocialAccountTokenRow | null,
): SocialAccount {
  const base: SocialAccount = {
    id: r.id,
    brandId: r.brandId,
    platform: r.platform,
    handle: r.handle,
    externalId: r.externalId,
    status: r.status,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
  if (token === undefined) return base;
  if (token === null) {
    return {
      ...base,
      hasToken: false,
      tokenExpiresAt: null,
      tokenScopes: [],
      tokenHealth: "unchecked",
      tokenCheckedAt: null,
    };
  }
  return {
    ...base,
    hasToken: true,
    tokenExpiresAt: isoOrNull(token.expiresAt),
    tokenScopes: token.scopes,
    tokenHealth: token.health,
    tokenCheckedAt: isoOrNull(token.checkedAt),
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

export function toBrandProduct(r: BrandProductRow): BrandProduct {
  return {
    id: r.id,
    brandId: r.brandId,
    name: r.name,
    description: r.description,
    category: r.category,
    tags: r.tags,
    notes: r.notes,
    imageAssetIds: r.imageAssetIds,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
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
    deletedAt: isoOrNull(r.deletedAt),
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
    deletedAt: isoOrNull(r.deletedAt),
    templateId: r.templateId ?? null,
    source:
      r.sourceContentId && r.sourceVersion !== null && r.sourceKind
        ? { contentId: r.sourceContentId, version: r.sourceVersion, kind: r.sourceKind }
        : null,
    ...publishDetailsOf(r.publishDetails),
  };
}

/** Stored publish details (N13) when there are any; a row this server cannot read is left out. */
function publishDetailsOf(raw: unknown): { publishDetails?: PublishDetails } {
  if (!raw) return {};
  const parsed = PublishDetails.safeParse(raw);
  return parsed.success ? { publishDetails: parsed.data } : {};
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

export type EditorDocumentRow = typeof schema.contentVersionDocuments.$inferSelect;

export function toVersion(
  r: ContentVersionRow,
  slides: SlideRow[],
  document: EditorDocumentRow | null = null,
): ContentVersion {
  return {
    ...toVersionSummary(r),
    editorDocument: document
      ? { kind: document.kind, assetId: document.assetId, format: document.format }
      : null,
    slides: [...slides]
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        html: s.html,
        width: s.width,
        height: s.height,
        renderedAssetId: s.renderedAssetId,
        layers: s.layers ?? null,
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
    priority: r.priority,
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    ...(r.workerId !== null ? { workerId: r.workerId } : {}),
    ...(r.progressMessage !== null ? { progressMessage: r.progressMessage } : {}),
    ...(r.cancelRequestedAt ? { cancelRequestedAt: iso(r.cancelRequestedAt) } : {}),
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
    ...(r.permalink !== null ? { permalink: r.permalink } : {}),
    delivery: r.delivery ?? null,
    cloudSyncedAt: isoOrNull(r.cloudSyncedAt),
    lastError: r.lastError ?? null,
    ...(r.externalPostId ? { externalPostId: r.externalPostId } : {}),
    ...(r.publishedAt ? { publishedAt: iso(r.publishedAt) } : {}),
    ...(r.publishWarnings?.length ? { warnings: r.publishWarnings } : {}),
    ...(r.detailsRev ? { detailsRevision: r.detailsRev } : {}),
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
    ...(r.permalink !== null ? { permalink: r.permalink } : {}),
    error: r.error,
    startedAt: iso(r.startedAt),
    finishedAt: isoOrNull(r.finishedAt),
    createdAt: iso(r.createdAt),
  };
}

// --- chat (A2) -------------------------------------------------------------------

export function toConversation(r: ConversationRow, activeRunId: string | null): Conversation {
  return {
    id: r.id,
    brandId: r.brandId,
    title: r.title,
    status: r.status,
    activeRunId,
    lastSeq: r.lastSeq,
    agentSession:
      r.agentSessionId && r.agentSessionRunId && r.agentSessionAt
        ? {
            id: r.agentSessionId,
            messageCount: r.agentSessionMessages ?? 0,
            runId: r.agentSessionRunId,
            updatedAt: iso(r.agentSessionAt),
          }
        : null,
    lastActivityAt: iso(r.lastActivityAt),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function toMessage(r: MessageRow): Message {
  return {
    id: r.id,
    conversationId: r.conversationId,
    role: r.role,
    status: r.status,
    runId: r.runId,
    // Written only by the chat service from contract-validated parts.
    parts: r.parts as MessagePart[],
    mentions: (r.mentions as MessageMention[] | null) ?? [],
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function toAgentRun(r: AgentRunRow): AgentRun {
  return {
    id: r.id,
    conversationId: r.conversationId,
    triggerMessageId: r.triggerMessageId,
    jobId: r.jobId,
    status: r.status,
    attempt: r.attempt,
    model: r.model,
    effort: r.effort ?? null,
    usage: (r.usage as RunUsage | null) ?? null,
    error: r.error,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    startedAt: isoOrNull(r.startedAt),
    finishedAt: isoOrNull(r.finishedAt),
  };
}

/** The bits of an item's generation job a PlanItem carries. */
export interface GenerationJobRef {
  id: string;
  status: JobStatus;
  error: string | null;
}

export function toPlanItem(r: PlanItemRow, job: GenerationJobRef | null): PlanItem {
  return {
    id: r.id,
    planId: r.planId,
    position: r.position,
    date: r.date,
    platforms: r.platforms,
    contentType: r.contentType,
    title: r.title,
    brief: r.brief,
    pillar: r.pillar,
    hook: r.hook,
    imageSlot: r.imageSlot,
    imageBrief: r.imageBrief,
    templateId: r.templateId ?? null,
    status: r.status,
    similar: r.similar ?? [],
    contentId: r.contentId,
    generation: job ? { jobId: job.id, status: job.status, error: job.error } : null,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function toPlan(r: PlanRow, items: PlanItem[]): Plan {
  return {
    id: r.id,
    brandId: r.brandId,
    conversationId: r.conversationId,
    runId: r.runId,
    title: r.title,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    status: r.status,
    summary: r.summary,
    revision: r.revision,
    decidedAt: isoOrNull(r.decidedAt),
    rejectionReason: r.rejectionReason,
    items: [...items].sort((a, b) => a.position - b.position),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

/** An alias with its asset and every name it has had (oldest first, current included). */
export interface AliasRecord {
  row: ConversationAliasRow;
  asset: AssetRow;
  names: string[];
}

export function toConversationAlias(r: AliasRecord): ConversationAlias {
  return {
    id: r.row.id,
    conversationId: r.row.conversationId,
    alias: r.row.alias,
    previousAliases: r.names.filter((n) => n !== r.row.alias),
    assetId: r.asset.id,
    kind: r.asset.kind,
    mimeType: r.asset.mimeType,
    width: r.asset.width,
    height: r.asset.height,
    filename: r.asset.originalFilename,
    contentPath: assetContentPath(r.asset.id),
    messageId: r.row.messageId,
    createdAt: iso(r.row.createdAt),
    updatedAt: iso(r.row.updatedAt),
  };
}

export function toTurnAlias(r: AliasRecord): TurnAlias {
  return { ...toConversationAlias(r), objectKey: r.asset.objectKey };
}

export function toContentCheckRun(r: ContentCheckRunRow): ContentCheckRun {
  return {
    id: r.id,
    contentId: r.contentId,
    brandId: r.brandId,
    version: r.version,
    versionId: r.versionId,
    trigger: r.trigger,
    jobId: r.jobId,
    strictness: r.strictness,
    summary: r.summary,
    blocking: r.blocking,
    // Stored by this server from validated input; the casts only narrow the JSON column type.
    results: r.results.map((x) => ({
      ...x,
      category: x.category as CheckCategory,
      status: x.status as CheckStatus,
      source: x.source as CheckSource,
    })),
    model: r.model,
    fromVersion: r.fromVersion,
    fixedVersion: r.fixedVersion,
    note: r.note,
    createdAt: iso(r.createdAt),
  };
}

export function toBrandCheckSettings(r: BrandCheckSettingsRow): BrandCheckSettings {
  return {
    brandId: r.brandId,
    disabledChecks: r.disabledChecks,
    bannedWords: r.bannedWords,
    strictness: r.strictness,
    autoFix: r.autoFix,
    updatedAt: iso(r.updatedAt),
  };
}
