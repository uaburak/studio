/**
 * In-memory stand-in for the parts of the API the handlers use. It applies turn ops
 * with the server's rules (seq per part from 1, no index gaps, no type change) so
 * `TurnWriter`, `StudioToolExecutor`, and consent polling are exercised for real.
 */
import {
  type AgentRun,
  type ApiClient,
  ApiError,
  type Asset,
  type Brand,
  type BrandCreate,
  type BrandKit,
  type BrandProfile,
  type BrandProfileCreate,
  type BrandSkill,
  BrandSkillCreate,
  type Content,
  type ContentStatus,
  type ContentVersion,
  type ContentVersionCreate,
  type ContentVersionUpdate,
  type Conversation,
  type ConversationAlias,
  emptyBrandKit,
  type Job,
  type JobCreate,
  type Message,
  type MessagePart,
  type Plan,
  type PlanAccept,
  type PlanGenerate,
  type PlanProposalPut,
  type Schedule,
  type ScheduleCreate,
  type SocialAccount,
  slugify,
  type TurnContext,
  type TurnOp,
  type WorkerScheduleOutcome,
} from "@studio/contract";
import type { StudioApi } from "../src/api.ts";

export const NOW = "2026-11-16T10:00:00.000Z";

export interface FakeApiState {
  context?: TurnContext;
  parts: MessagePart[];
  seqs: Map<number, number>;
  opsCalls: TurnOp[][];
  plans: PlanProposalPut[];
  storedPlans: Map<string, Plan>;
  planAccepts: { id: string; input: PlanAccept }[];
  planGenerates: { id: string; input: PlanGenerate }[];
  completed: unknown[];
  failed: unknown[];
  brands: Brand[];
  /** Brand kits by brand id (P2); a brand without one reads as an empty kit. */
  kits: Map<string, BrandKit>;
  /** Brand skills (every brand, oldest first). */
  skills: BrandSkill[];
  profiles: Map<string, BrandProfile>;
  profileHistory: BrandProfile[];
  contents: Map<string, Content>;
  contentApprovals: { id: string; hash: string }[];
  contentTransitions: { id: string; to: ContentStatus }[];
  versions: ContentVersion[];
  versionCreates: ContentVersionCreate[];
  versionUpdates: { contentId: string; version: number; input: ContentVersionUpdate }[];
  socialAccounts: SocialAccount[];
  accountTokens: Map<string, string | null>;
  schedules: Schedule[];
  scheduleOutcomes: { id: string; outcome: WorkerScheduleOutcome }[];
  jobs: Job[];
  assetRecords: Asset[];
  uploads: {
    brandId: string;
    kind?: string;
    source?: string;
    width?: number;
    height?: number;
    bytes: number;
  }[];
  contentUpdates: unknown[];
  conversationUpdates: { id: string; input: Partial<Conversation> }[];
  aliases: Map<string, ConversationAlias[]>;
  assets: Map<string, { bytes: Uint8Array; contentType: string }>;
  closed: boolean;
  /** Simulate the owner clicking Allow or Deny on a pending consent card. */
  decideConsent(consentId: string, allow: boolean): void;
}

export function fakeRun(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run_1",
    conversationId: "conv_1",
    triggerMessageId: "msg_1",
    jobId: "job_1",
    status: "running",
    attempt: 1,
    model: null,
    usage: null,
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    ...overrides,
  };
}

export function fakeBrand(overrides: Partial<Brand> = {}): Brand {
  return {
    id: "brand_1",
    name: "MTM Agro",
    slug: "mtm-agro",
    defaultLanguage: "tr",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function message(parts: MessagePart[]): Message {
  return {
    id: "msg_assistant",
    conversationId: "conv_1",
    role: "assistant",
    status: "streaming",
    runId: "run_1",
    parts: parts.map((p) => ({ ...p })),
    mentions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const conflict = (msg: string, code: "conflict" | "invalid_transition" = "conflict") =>
  new ApiError(msg, 409, code);

export function createFakeApi(init: Partial<FakeApiState> = {}): {
  api: StudioApi;
  state: FakeApiState;
} {
  const storedPlans = init.storedPlans ?? new Map<string, Plan>();
  if (init.context?.openPlan && !storedPlans.has(init.context.openPlan.id)) {
    storedPlans.set(init.context.openPlan.id, init.context.openPlan);
  }

  const state: FakeApiState = {
    parts: [],
    seqs: new Map(),
    opsCalls: [],
    plans: [],
    storedPlans,
    planAccepts: [],
    planGenerates: [],
    completed: [],
    failed: [],
    brands: [],
    kits: new Map(),
    skills: [],
    profiles: new Map(),
    profileHistory: [],
    contents: new Map(),
    contentApprovals: [],
    contentTransitions: [],
    versions: [],
    versionCreates: [],
    versionUpdates: [],
    socialAccounts: [],
    accountTokens: new Map(),
    schedules: [],
    scheduleOutcomes: [],
    jobs: [],
    assetRecords: [],
    uploads: [],
    contentUpdates: [],
    conversationUpdates: [],
    aliases: new Map(),
    assets: new Map(),
    closed: false,
    decideConsent(consentId: string, allow: boolean) {
      const idx = state.parts.findIndex((p) => p.type === "consent" && p.consentId === consentId);
      const card = idx >= 0 ? state.parts[idx] : undefined;
      if (card?.type !== "consent") throw new Error(`consent ${consentId} not found`);
      state.parts[idx] = {
        ...card,
        state: allow ? "allowed" : "denied",
        decidedAt: NOW,
      };
    },
    ...init,
  };

  const applyOp = (op: TurnOp) => {
    if (op.op === "text.delta") {
      const last = state.seqs.get(op.index) ?? 0;
      if (op.seq <= last) return; // retry: skipped
      if (op.seq !== last + 1) throw conflict(`seq gap at ${op.index}`);
      const existing = state.parts[op.index];
      if (!existing) {
        if (op.index !== state.parts.length || op.seq !== 1) throw conflict("index gap");
        state.parts.push({ type: "text", text: op.text });
      } else if (existing.type === "text") {
        existing.text += op.text;
      } else {
        throw conflict("type change");
      }
      state.seqs.set(op.index, op.seq);
      return;
    }
    if (op.index > state.parts.length) throw conflict("index gap");
    const existing = state.parts[op.index];
    if (existing && existing.type !== op.part.type) throw conflict("type change");
    if (existing?.type === "consent" && existing.state !== "pending") {
      // Server rule: once decided or expired, late updates of the same consentId are no-ops.
      if (op.part.type === "consent" && existing.consentId === op.part.consentId) return;
      throw conflict("consent already decided");
    }
    const part = { ...(op.part as object) } as MessagePart;
    if (part.type === "question") Object.assign(part, { answer: null });
    if (part.type === "progress") {
      Object.assign(part, {
        detail: (op.part as { detail?: string | null }).detail ?? null,
        current: null,
        total: null,
      });
    }
    if (part.type === "tool_step") {
      Object.assign(part, {
        summary: (op.part as { summary?: string | null }).summary ?? null,
      });
    }
    if (part.type === "consent") {
      const st = (op.part as { state?: "pending" | "expired" }).state ?? "pending";
      Object.assign(part, {
        detail: (op.part as { detail?: string | null }).detail ?? null,
        state: st,
        decidedAt: st === "expired" ? NOW : null,
      });
    }
    state.parts[op.index] = part;
  };

  const check = () => {
    if (state.closed) throw conflict("run is closed", "invalid_transition");
  };

  const client = {
    workerTurns: {
      start: async () => {
        if (!state.context) throw new ApiError("no context", 404, "not_found");
        return state.context;
      },
      message: async () => ({
        run: state.closed ? fakeRun({ status: "cancelled" }) : fakeRun(),
        message: state.parts.length > 0 ? message(state.parts) : null,
      }),
      ops: async (_runId: string, input: { ops: TurnOp[] }) => {
        check();
        state.opsCalls.push(input.ops);
        for (const op of input.ops) applyOp(op);
        return { run: fakeRun(), message: message(state.parts) };
      },
      putPlan: async (_runId: string, input: PlanProposalPut) => {
        check();
        state.plans.push(input);
        const planId = "plan_1";
        if (!state.parts.some((p) => p.type === "plan_proposal")) {
          state.parts.push({ type: "plan_proposal", planId });
        }
        const brandId = input.brandId ?? state.context?.conversation.brandId ?? "brand_1";
        if (state.context && !state.context.conversation.brandId) {
          state.context.conversation.brandId = brandId;
        }
        const plan: Plan = {
          id: planId,
          brandId,
          conversationId: "conv_1",
          runId: "run_1",
          title: input.title ?? "",
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          status: "proposed",
          summary: input.summary ?? "",
          revision: state.plans.length,
          decidedAt: null,
          rejectionReason: null,
          items: input.items.map((item, position) => ({
            id: `item_${position}`,
            planId,
            position,
            date: item.date ?? null,
            platforms: item.platforms,
            contentType: item.contentType,
            title: item.title,
            brief: item.brief ?? "",
            pillar: item.pillar ?? null,
            imageSlot: item.imageSlot ?? "none",
            imageBrief: item.imageBrief ?? null,
            status: "planned",
            contentId: null,
            generation: null,
            createdAt: NOW,
            updatedAt: NOW,
          })),
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.storedPlans.set(planId, plan);
        return { plan, message: message(state.parts) };
      },
      complete: async (_runId: string, input: unknown) => {
        check();
        state.completed.push(input);
        return fakeRun({ status: "completed" });
      },
      fail: async (_runId: string, input: unknown) => {
        state.failed.push(input);
        return fakeRun({ status: "failed" });
      },
    },
    plans: {
      get: async (id: string) => {
        const p = state.storedPlans.get(id);
        if (!p) throw new ApiError("plan not found", 404, "not_found");
        return p;
      },
      accept: async (id: string, input: PlanAccept) => {
        const p = state.storedPlans.get(id);
        if (!p) throw new ApiError("plan not found", 404, "not_found");
        state.planAccepts.push({ id, input });
        const skip = new Set(input.skipItemIds ?? []);
        const updated: Plan = {
          ...p,
          status: "accepted",
          decidedAt: NOW,
          items: p.items.map((item, idx) =>
            skip.has(item.id)
              ? { ...item, status: "skipped" }
              : { ...item, status: "accepted", contentId: `content_plan_${idx + 1}` },
          ),
        };
        state.storedPlans.set(id, updated);
        return updated;
      },
      generate: async (id: string, input: PlanGenerate = {}) => {
        const p = state.storedPlans.get(id);
        if (!p) throw new ApiError("plan not found", 404, "not_found");
        state.planGenerates.push({ id, input });
        const targetIds = input.itemIds ? new Set(input.itemIds) : null;
        const acceptedItems = p.items.filter(
          (i) => i.status === "accepted" && (!targetIds || targetIds.has(i.id)),
        );
        const jobs: Job[] = acceptedItems.map((item, idx) => ({
          id: `job_gen_${idx + 1}`,
          type: "content.generate",
          status: "queued",
          brandId: p.brandId,
          contentId: item.contentId ?? `content_plan_${idx + 1}`,
          payload: {
            brief: item.brief,
            ...(input.model ? { model: input.model } : {}),
            ...(input.effort ? { effort: input.effort } : {}),
          },
          createdAt: NOW,
          updatedAt: NOW,
        }));
        return { plan: p, jobs };
      },
    },
    brands: {
      list: async () => ({ items: state.brands, nextCursor: null }),
      get: async (id: string) => {
        const b =
          state.brands.find((x) => x.id === id) ??
          (state.context?.brand?.id === id ? state.context.brand : undefined);
        if (!b) throw new ApiError("brand not found", 404, "not_found");
        return b;
      },
      create: async (input: BrandCreate) => {
        const brand: Brand = {
          id: `brand_${state.brands.length + 1}`,
          name: input.name,
          slug: input.slug ?? slugify(input.name),
          defaultLanguage: input.defaultLanguage ?? "tr",
          status: "active",
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.brands.push(brand);
        return brand;
      },
    },
    brandSkills: {
      list: async (brandId: string) => ({
        items: state.skills.filter((s) => s.brandId === brandId),
        nextCursor: null,
      }),
      create: async (brandId: string, raw: unknown) => {
        const input = BrandSkillCreate.parse(raw);
        if (state.skills.some((s) => s.brandId === brandId && s.name === input.name)) {
          throw conflict(`a skill named "${input.name}" already exists`);
        }
        const created: BrandSkill = {
          id: `skill_${state.skills.length + 1}`,
          brandId,
          name: input.name,
          description: input.description,
          body: input.body,
          enabled: input.enabled,
          version: 1,
          origin: input.origin,
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.skills.push(created);
        return created;
      },
    },
    brandKits: {
      get: async (brandId: string) => {
        if (!state.brands.some((b) => b.id === brandId) && state.context?.brand?.id !== brandId) {
          throw new ApiError("brand not found", 404, "not_found");
        }
        return state.kits.get(brandId) ?? emptyBrandKit(brandId);
      },
    },
    brandProfiles: {
      list: async (brandId: string) => ({
        items: state.profileHistory.filter((p) => p.brandId === brandId),
        nextCursor: null,
      }),
      current: async (brandId: string) => {
        const p =
          state.profiles.get(brandId) ??
          (state.context?.brandProfile?.brandId === brandId
            ? state.context.brandProfile
            : undefined);
        if (!p) throw new ApiError("no approved profile", 404, "not_found");
        return p;
      },
      get: async (brandId: string, version?: number) => {
        const fromHist =
          version !== undefined
            ? state.profileHistory.find((x) => x.brandId === brandId && x.version === version)
            : undefined;
        const p = fromHist ?? state.profiles.get(brandId);
        if (!p) throw new ApiError("no profile", 404, "not_found");
        return p;
      },
      create: async (brandId: string, input: BrandProfileCreate = {}) => {
        const existingCount = state.profileHistory.filter((p) => p.brandId === brandId).length;
        const profile: BrandProfile = {
          id: `prof_${state.profileHistory.length + 1}`,
          brandId,
          version: existingCount + 1,
          status: "draft",
          isCurrent: false,
          tokens: (input.tokens ?? {}) as Record<string, unknown>,
          designRules: input.designRules ?? "",
          voice: input.voice ?? "",
          createdAt: NOW,
          updatedAt: NOW,
          approvedAt: null,
        };
        state.profileHistory.push(profile);
        return profile;
      },
      approve: async (brandId: string, version: number) => {
        const idx = state.profileHistory.findIndex(
          (p) => p.brandId === brandId && p.version === version,
        );
        if (idx < 0) throw new ApiError("profile version not found", 404, "not_found");
        for (const p of state.profileHistory) {
          if (p.brandId === brandId) p.isCurrent = false;
        }
        const target = state.profileHistory[idx] as BrandProfile;
        const approved: BrandProfile = {
          ...target,
          status: "approved",
          isCurrent: true,
          approvedAt: NOW,
          updatedAt: NOW,
        };
        state.profileHistory[idx] = approved;
        state.profiles.set(brandId, approved);
        return approved;
      },
    },
    socialAccounts: {
      list: async (query?: { brandId?: string; platform?: string }) => ({
        items: state.socialAccounts.filter(
          (a) =>
            (!query?.brandId || a.brandId === query.brandId) &&
            (!query?.platform || a.platform === query.platform),
        ),
        nextCursor: null,
      }),
      get: async (id: string) => {
        const a = state.socialAccounts.find((x) => x.id === id);
        if (!a) throw new ApiError("social account not found", 404, "not_found");
        return a;
      },
    },
    schedules: {
      list: async () => ({ items: state.schedules, nextCursor: null }),
      get: async (id: string) => {
        const s = state.schedules.find((x) => x.id === id);
        if (!s) throw new ApiError("schedule not found", 404, "not_found");
        return s;
      },
      create: async (input: ScheduleCreate) => {
        const content = state.contents.get(input.contentId);
        const account = state.socialAccounts.find((a) => a.id === input.socialAccountId);
        if (!content) throw new ApiError("content not found", 404, "not_found");
        if (!account) throw new ApiError("account not found", 404, "not_found");
        const schedule: Schedule = {
          id: `sched_${state.schedules.length + 1}`,
          contentId: content.id,
          brandId: content.brandId,
          platform: input.platform ?? account.platform,
          socialAccountId: account.id,
          versionId: content.approval?.versionId ?? content.currentVersion?.id ?? "ver_1",
          contentHash:
            content.approval?.contentHash ?? content.currentVersion?.contentHash ?? "a".repeat(64),
          scheduledAt: input.scheduledAt,
          status: "pending",
          cancelledAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.schedules.push(schedule);
        return schedule;
      },
    },
    workerSchedules: {
      due: async (query?: { before?: string; limit?: number }) => {
        const items = state.schedules
          .filter(
            (s) =>
              s.status === "pending" &&
              (!query?.before || Date.parse(s.scheduledAt) <= Date.parse(query.before)),
          )
          .slice(0, query?.limit ?? 100);
        return { items };
      },
      credentials: async (id: string) => {
        const schedule = state.schedules.find((s) => s.id === id);
        if (!schedule) throw new ApiError("schedule not found", 404, "not_found");
        const account = state.socialAccounts.find((a) => a.id === schedule.socialAccountId);
        if (!account) throw new ApiError("account not found", 404, "not_found");
        const content = state.contents.get(schedule.contentId);
        if (!content) throw new ApiError("content not found", 404, "not_found");
        if (
          !content.approval ||
          content.approval.versionId !== schedule.versionId ||
          content.approval.contentHash !== schedule.contentHash
        ) {
          throw new ApiError("approval mismatch", 409, "hash_mismatch");
        }
        const version = state.versions.find((v) => v.id === schedule.versionId);
        if (!version) throw new ApiError("version not found", 404, "not_found");
        const accessToken = state.accountTokens.has(account.id)
          ? (state.accountTokens.get(account.id) ?? null)
          : "fake_access_token_123456";
        return { schedule, account, content, version, accessToken };
      },
      outcome: async (id: string, input: WorkerScheduleOutcome) => {
        const idx = state.schedules.findIndex((s) => s.id === id);
        if (idx < 0) throw new ApiError("schedule not found", 404, "not_found");
        state.scheduleOutcomes.push({ id, outcome: input });
        const cur = state.schedules[idx] as Schedule;
        const updated: Schedule = {
          ...cur,
          status: input.status,
          ...(input.permalink !== undefined ? { permalink: input.permalink } : {}),
          updatedAt: NOW,
        };
        state.schedules[idx] = updated;
        if (input.accountNeedsReauth) {
          const accIdx = state.socialAccounts.findIndex((a) => a.id === cur.socialAccountId);
          if (accIdx >= 0 && state.socialAccounts[accIdx]) {
            state.socialAccounts[accIdx] = {
              ...state.socialAccounts[accIdx],
              status: "needs_reauth",
            };
          }
        }
        const c = state.contents.get(cur.contentId);
        if (c) {
          state.contents.set(cur.contentId, {
            ...c,
            status:
              input.status === "published"
                ? "published"
                : input.status === "failed"
                  ? "failed"
                  : "publishing",
          });
        }
        return updated;
      },
    },
    jobs: {
      create: async (input: JobCreate) => {
        const job: Job = {
          id: `job_created_${state.jobs.length + 1}`,
          type: input.type,
          status: "queued",
          payload: input.payload ?? {},
          ...(input.brandId ? { brandId: input.brandId } : {}),
          ...(input.contentId ? { contentId: input.contentId } : {}),
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.jobs.push(job);
        return job;
      },
      get: async (id: string) => {
        const j = state.jobs.find((x) => x.id === id);
        if (!j) throw new ApiError("job not found", 404, "not_found");
        return j;
      },
      list: async () => ({ items: state.jobs, nextCursor: null }),
    },
    contents: {
      create: async (input: {
        brandId: string;
        type: Content["type"];
        title: string;
        brief?: string;
        targetPlatforms?: Content["targetPlatforms"];
      }) => {
        const created: Content = {
          id: `cnt_created_${state.contents.size + 1}`,
          brandId: input.brandId,
          type: input.type,
          title: input.title,
          brief: input.brief ?? "",
          status: "draft",
          targetPlatforms: input.targetPlatforms ?? [],
          caption: "",
          currentVersion: null,
          approval: null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        state.contents.set(created.id, created);
        return created;
      },
      list: async (query?: { brandId?: string; status?: string; type?: string }) => ({
        items: [...state.contents.values()].filter(
          (c) =>
            (!query?.brandId || c.brandId === query.brandId) &&
            (!query?.status || c.status === query.status) &&
            (!query?.type || c.type === query.type),
        ),
        nextCursor: null,
      }),
      get: async (id: string) => {
        const c = state.contents.get(id);
        if (!c) throw new ApiError("content not found", 404, "not_found");
        return c;
      },
      update: async (id: string, input: unknown) => {
        state.contentUpdates.push(input);
        const existing = state.contents.get(id);
        if (existing && input && typeof input === "object") {
          const updated = { ...existing, ...(input as Partial<Content>) };
          state.contents.set(id, updated);
          return updated;
        }
        return existing;
      },
      transition: async (id: string, to: ContentStatus) => {
        const c = state.contents.get(id);
        if (!c) throw new ApiError("content not found", 404, "not_found");
        state.contentTransitions.push({ id, to });
        const updated: Content = { ...c, status: to, updatedAt: NOW };
        state.contents.set(id, updated);
        return updated;
      },
      approve: async (id: string, hash: string) => {
        const c = state.contents.get(id);
        if (!c) throw new ApiError("content not found", 404, "not_found");
        if (!c.currentVersion || c.currentVersion.contentHash !== hash) {
          throw new ApiError("hash mismatch", 409, "hash_mismatch");
        }
        state.contentApprovals.push({ id, hash });
        const updated: Content = {
          ...c,
          status: "approved",
          approval: {
            versionId: c.currentVersion.id,
            contentHash: hash,
            approvedAt: NOW,
          },
          updatedAt: NOW,
        };
        state.contents.set(id, updated);
        return updated;
      },
      versions: {
        list: async (contentId: string) => ({
          items: state.versions.filter((v) => v.contentId === contentId),
          nextCursor: null,
        }),
        get: async (contentId: string, version: number) => {
          const v = state.versions.find((x) => x.contentId === contentId && x.version === version);
          if (!v) throw new ApiError("version not found", 404, "not_found");
          return v;
        },
        create: async (contentId: string, input: ContentVersionCreate) => {
          state.versionCreates.push(input);
          const verNum = state.versions.filter((v) => v.contentId === contentId).length + 1;
          const version: ContentVersion = {
            id: `ver_${state.versions.length + 1}`,
            contentId,
            version: verNum,
            origin: input.origin,
            contentHash: "a".repeat(64),
            slideCount: input.slides.length,
            note: input.note ?? null,
            jobId: input.jobId ?? null,
            createdAt: NOW,
            updatedAt: NOW,
            slides: input.slides.map((s, i) => ({
              ...s,
              renderedAssetId: input.renderedAssetIds?.[i] ?? null,
              layers: input.layouts?.[i] ?? null,
            })),
          };
          state.versions.push(version);
          const existingContent = state.contents.get(contentId);
          if (existingContent) {
            state.contents.set(contentId, {
              ...existingContent,
              status: "draft",
              approval: null,
              currentVersion: {
                id: version.id,
                version: version.version,
                contentHash: version.contentHash,
              },
              updatedAt: NOW,
            });
          }
          return version;
        },
        update: async (contentId: string, versionNum: number, input: ContentVersionUpdate) => {
          state.versionUpdates.push({ contentId, version: versionNum, input });
          const idx = state.versions.findIndex(
            (v) => v.contentId === contentId && v.version === versionNum,
          );
          if (idx < 0) throw new ApiError("version not found", 404, "not_found");
          const cur = state.versions[idx] as ContentVersion;
          const updated: ContentVersion = {
            ...cur,
            ...(input.note !== undefined ? { note: input.note } : {}),
            slides: cur.slides.map((s, i) => ({
              ...s,
              renderedAssetId:
                input.renderedAssetIds !== undefined
                  ? (input.renderedAssetIds[i] ?? null)
                  : s.renderedAssetId,
              layers: input.layouts !== undefined ? (input.layouts[i] ?? null) : (s.layers ?? null),
            })),
            updatedAt: NOW,
          };
          state.versions[idx] = updated;
          return updated;
        },
      },
    },
    assets: {
      list: async (query?: { brandId?: string; kind?: string; source?: string }) => ({
        items: state.assetRecords.filter(
          (a) =>
            (!query?.brandId || a.brandId === query.brandId) &&
            (!query?.kind || a.kind === query.kind) &&
            (!query?.source || a.source === query.source),
        ),
        nextCursor: null,
      }),
      get: async (id: string) => {
        const a = state.assetRecords.find((x) => x.id === id);
        if (!a) throw new ApiError("asset not found", 404, "not_found");
        return a;
      },
      contentUrl: (id: string) => `http://fake/api/assets/${encodeURIComponent(id)}/content`,
      upload: async (input: {
        brandId: string;
        kind?: string;
        source?: string;
        width?: number;
        height?: number;
        durationMs?: number;
        filename?: string;
        file: Blob;
      }) => {
        const bytes = new Uint8Array(await input.file.arrayBuffer());
        const id = `asset_gen_${state.uploads.length + 1}`;
        state.uploads.push({
          brandId: input.brandId,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.source ? { source: input.source } : {}),
          ...(input.width ? { width: input.width } : {}),
          ...(input.height ? { height: input.height } : {}),
          bytes: bytes.byteLength,
        });
        state.assets.set(id, { bytes, contentType: input.file.type });
        const assetRecord: Asset = {
          id,
          brandId: input.brandId,
          kind: (input.kind as Asset["kind"]) ?? "image",
          source: (input.source as Asset["source"]) ?? "generated",
          objectKey: `brands/${input.brandId}/${id}`,
          mimeType: input.file.type || "application/octet-stream",
          bytes: bytes.byteLength,
          sha256: "0".repeat(64),
          width: input.width ?? null,
          height: input.height ?? null,
          durationMs: input.durationMs ?? null,
          originalFilename: input.filename ?? null,
          createdAt: NOW,
        };
        state.assetRecords.push(assetRecord);
        return assetRecord;
      },
    },
    conversations: {
      update: async (
        id: string,
        input: { brandId?: string; title?: string; status?: "active" | "archived" },
      ) => {
        state.conversationUpdates.push({ id, input });
        if (state.context && state.context.conversation.id === id) {
          if (input.brandId !== undefined) state.context.conversation.brandId = input.brandId;
          if (input.title !== undefined) state.context.conversation.title = input.title;
          if (input.status !== undefined) state.context.conversation.status = input.status;
          return state.context.conversation;
        }
        return {
          id,
          brandId: input.brandId ?? null,
          title: input.title ?? "",
          status: input.status ?? "active",
          activeRunId: null,
          lastSeq: 0,
          lastActivityAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        };
      },
      aliases: {
        list: async (conversationId: string) => ({
          items: state.aliases.get(conversationId) ?? [],
        }),
      },
    },
  };

  const api: StudioApi = {
    client: client as unknown as ApiClient,
    baseUrl: "http://fake",
    async downloadAsset(assetId) {
      const a = state.assets.get(assetId);
      if (!a) throw new ApiError(`asset ${assetId}: HTTP 404`, 404);
      return { bytes: a.bytes, contentType: a.contentType };
    },
  };
  return { api, state };
}
