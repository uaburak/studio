/**
 * In-memory stand-in for the parts of the API the handlers use. It applies turn ops
 * with the server's rules (seq per part from 1, no index gaps) so the writer is
 * exercised for real.
 */
import {
  type AgentRun,
  type ApiClient,
  ApiError,
  type Asset,
  type Brand,
  type BrandProfile,
  type Content,
  type ContentVersion,
  type ContentVersionCreate,
  type ConversationAlias,
  type Message,
  type MessagePart,
  type Plan,
  type PlanProposalPut,
  type TurnContext,
  type TurnOp,
} from "@studio/contract";
import type { StudioApi } from "../src/api.ts";

export const NOW = "2026-11-16T10:00:00.000Z";

export interface FakeApiState {
  context?: TurnContext;
  parts: MessagePart[];
  seqs: Map<number, number>;
  opsCalls: TurnOp[][];
  plans: PlanProposalPut[];
  completed: unknown[];
  failed: unknown[];
  brands: Brand[];
  profiles: Map<string, BrandProfile>;
  contents: Map<string, Content>;
  versions: ContentVersion[];
  versionCreates: ContentVersionCreate[];
  uploads: {
    brandId: string;
    kind?: string;
    source?: string;
    width?: number;
    height?: number;
    bytes: number;
  }[];
  contentUpdates: unknown[];
  aliases: Map<string, ConversationAlias[]>;
  assets: Map<string, { bytes: Uint8Array; contentType: string }>;
  closed: boolean;
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
    parts,
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
  const state: FakeApiState = {
    parts: [],
    seqs: new Map(),
    opsCalls: [],
    plans: [],
    completed: [],
    failed: [],
    brands: [],
    profiles: new Map(),
    contents: new Map(),
    versions: [],
    versionCreates: [],
    uploads: [],
    contentUpdates: [],
    aliases: new Map(),
    assets: new Map(),
    closed: false,
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
    const part = { ...(op.part as object) } as MessagePart;
    if (part.type === "question") Object.assign(part, { answer: null });
    if (part.type === "progress") {
      Object.assign(part, {
        detail: (op.part as { detail?: string | null }).detail ?? null,
        current: null,
        total: null,
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
        const plan = {
          id: planId,
          brandId: input.brandId ?? state.context?.conversation.brandId ?? "brand_1",
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
        } satisfies Plan;
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
    brands: {
      list: async () => ({ items: state.brands, nextCursor: null }),
      get: async (id: string) => {
        const b = state.brands.find((x) => x.id === id);
        if (!b) throw new ApiError("brand not found", 404, "not_found");
        return b;
      },
    },
    brandProfiles: {
      current: async (brandId: string) => {
        const p = state.profiles.get(brandId);
        if (!p) throw new ApiError("no approved profile", 404, "not_found");
        return p;
      },
      get: async (brandId: string) => {
        const p = state.profiles.get(brandId);
        if (!p) throw new ApiError("no profile", 404, "not_found");
        return p;
      },
    },
    contents: {
      get: async (id: string) => {
        const c = state.contents.get(id);
        if (!c) throw new ApiError("content not found", 404, "not_found");
        return c;
      },
      update: async (id: string, input: unknown) => {
        state.contentUpdates.push(input);
        return state.contents.get(id);
      },
      versions: {
        list: async (contentId: string) => ({
          items: state.versions.filter((v) => v.contentId === contentId),
          nextCursor: null,
        }),
        get: async (contentId: string, version: number) =>
          state.versions.find((v) => v.contentId === contentId && v.version === version),
        create: async (contentId: string, input: ContentVersionCreate) => {
          state.versionCreates.push(input);
          const version: ContentVersion = {
            id: `ver_${state.versions.length + 1}`,
            contentId,
            version: state.versions.filter((v) => v.contentId === contentId).length + 1,
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
            })),
          };
          state.versions.push(version);
          return version;
        },
      },
    },
    assets: {
      upload: async (input: {
        brandId: string;
        kind?: string;
        source?: string;
        width?: number;
        height?: number;
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
        return { id } as Asset;
      },
    },
    conversations: {
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
