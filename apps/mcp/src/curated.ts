// Curated high-level tools: what an agent needs most, in one call each.
//
//   studio_status          is Studio up, brands, Claude / Gemini readiness, AI spend
//   studio_brand_overview  brand + kit + profile + products + skills + accounts
//   studio_chat            send a chat message as the owner and wait for the agent's reply
//   studio_answer          answer a question card or allow / deny a consent card, then wait
//   studio_wait_job        poll a job to its end, with progress
//   studio_upload_file     upload a local file as a brand asset
import { randomUUID } from "node:crypto";
import { type HttpMethod, StudioError } from "./client.ts";
import { FileRefused } from "./files.ts";
import { ArgumentError, buildForm, needsConfirm, type RunContext } from "./operations.ts";
import { jsonResult, responseResult, type ToolResult, textResult } from "./output.ts";
import type { JsonSchema } from "./spec.ts";

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface CuratedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: ToolAnnotations;
  run(args: Record<string, unknown>, ctx: RunContext): Promise<ToolResult>;
}

class ApiFailure extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(
  ctx: RunContext,
  method: HttpMethod,
  path: string,
  options: { query?: Record<string, unknown>; json?: unknown } = {},
): Promise<unknown> {
  const res = await ctx.client.request({ method, path, ...options });
  if (res.status >= 400) throw new ApiFailure(res.status, res.json ?? res.text);
  return res.json ?? null;
}

/** null on 404, the value otherwise. */
async function optional(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 404) return null;
    throw error;
  }
}

function settled(result: PromiseSettledResult<unknown>): unknown {
  if (result.status === "fulfilled") return result.value;
  const error = result.reason;
  if (error instanceof ApiFailure) return { error: `HTTP ${error.status}`, body: error.body };
  return { error: error instanceof Error ? error.message : String(error) };
}

const id = (description: string): JsonSchema => ({ type: "string", minLength: 1, description });

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (!value) throw new ArgumentError(`${key} gerekli (required)`);
  return value;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function seconds(args: Record<string, unknown>, key: string, fallback: number, max: number) {
  const value = args[key];
  const n = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  return Math.min(n, max);
}

/** Polling interval of the wait loops (tests make it short). */
export const timing = { pollMs: 1500 };

// --- studio_status ------------------------------------------------------------------------------

interface Brand {
  id: string;
  name?: string;
  status?: string;
}

const statusTool: CuratedTool = {
  name: "studio_status",
  title: "Studio durumu",
  description:
    "Studio açık mı, markalar, Mac worker'ı, Claude / Gemini / diğer sağlayıcıların hazır olup " +
    "olmadığı, yapay zekâ harcaması ve bütçe ayarı. Başka bir şey yapmadan önce çağırın. " +
    "(Is Studio up; brands; worker, Claude and Gemini readiness; AI spend and budget.)",
  inputSchema: { type: "object", properties: {} },
  annotations: { title: "Studio durumu", readOnlyHint: true, openWorldHint: false },
  async run(_args, ctx) {
    let health: unknown;
    try {
      health = await api(ctx, "GET", "/api/health");
    } catch (error) {
      if (error instanceof StudioError) {
        return jsonResult(
          { up: false, message: error.message },
          (t) => ctx.client.scrub(t),
          0,
          true,
        );
      }
      health = settled({ status: "rejected", reason: error });
    }
    const [brands, presence, claude, gemini, providers, spend, preferences] =
      await Promise.allSettled([
        api(ctx, "GET", "/api/brands", { query: { limit: 100 } }),
        api(ctx, "GET", "/api/workers/presence"),
        api(ctx, "GET", "/api/workers/claude"),
        api(ctx, "GET", "/api/workers/gemini"),
        api(ctx, "GET", "/api/workers/providers"),
        api(ctx, "GET", "/api/ai/spend"),
        api(ctx, "GET", "/api/ai/preferences"),
      ]);
    const brandList = settled(brands as PromiseSettledResult<unknown>) as
      | { items?: Brand[] }
      | { error: string };
    return jsonResult(
      {
        up: true,
        baseUrl: ctx.client.baseUrl,
        health,
        brands:
          "items" in brandList && Array.isArray(brandList.items)
            ? brandList.items.map((b) => ({ id: b.id, name: b.name, status: b.status }))
            : brandList,
        worker: settled(presence),
        claude: settled(claude),
        gemini: settled(gemini),
        otherProviders: settled(providers),
        aiSpend: settled(spend),
        aiPreferences: settled(preferences),
      },
      (t) => ctx.client.scrub(t),
    );
  },
};

// --- studio_brand_overview ----------------------------------------------------------------------

const brandOverviewTool: CuratedTool = {
  name: "studio_brand_overview",
  title: "Marka özeti",
  description:
    "Bir markanın her şeyi tek çağrıda: marka, marka kiti, onaylı profil, ürünler, skill'ler, " +
    "bağlı sosyal hesaplar. (Brand + kit + current profile + products + skills + accounts.)",
  inputSchema: {
    type: "object",
    properties: {
      brandId: id("Marka kimliği (studio_status brand listesinden). Brand id."),
      response_offset: { type: "integer", minimum: 0, description: "Kesilen yanıtın devamı." },
    },
    required: ["brandId"],
  },
  annotations: { title: "Marka özeti", readOnlyHint: true, openWorldHint: false },
  async run(args, ctx) {
    const brandId = seg(requireStr(args, "brandId"));
    let brand: unknown;
    try {
      brand = await api(ctx, "GET", `/api/brands/${brandId}`);
    } catch (error) {
      if (error instanceof ApiFailure) {
        return jsonResult(
          { httpStatus: error.status, error: error.body },
          (t) => ctx.client.scrub(t),
          0,
          true,
        );
      }
      throw error;
    }
    const [kit, profile, products, skills, accounts] = await Promise.allSettled([
      optional(api(ctx, "GET", `/api/brands/${brandId}/kit`)),
      optional(api(ctx, "GET", `/api/brands/${brandId}/profiles/current`)),
      api(ctx, "GET", `/api/brands/${brandId}/products`, { query: { limit: 100 } }),
      api(ctx, "GET", `/api/brands/${brandId}/skills`, { query: { limit: 100 } }),
      api(ctx, "GET", "/api/social-accounts", { query: { brandId: args.brandId, limit: 100 } }),
    ]);
    const offset = typeof args.response_offset === "number" ? args.response_offset : 0;
    return jsonResult(
      {
        brand,
        kit: settled(kit),
        currentProfile: settled(profile),
        products: settled(products),
        skills: settled(skills),
        socialAccounts: settled(accounts),
      },
      (t) => ctx.client.scrub(t),
      offset,
    );
  },
};

// --- studio_wait_job ----------------------------------------------------------------------------

const TERMINAL_JOB = new Set(["succeeded", "failed", "cancelled"]);

interface Job {
  id: string;
  type?: string;
  status: string;
  progress?: number;
  progressMessage?: string;
  error?: string;
  output?: unknown;
}

const waitJobTool: CuratedTool = {
  name: "studio_wait_job",
  title: "İşi bekle",
  description:
    "Bir işi (üretim, render, görsel, yayın …) bitene kadar izler ve sonucunu döndürür; ilerlemeyi " +
    "bildirir. Süre dolarsa işin o anki durumunu döndürür, yeniden çağırarak beklemeye devam edin. " +
    "(Polls a job to succeeded / failed / cancelled, with progress.)",
  inputSchema: {
    type: "object",
    properties: {
      jobId: id("İş kimliği (Job id)."),
      timeoutSeconds: {
        type: "number",
        minimum: 1,
        maximum: 1800,
        description: "En çok bu kadar bekle (varsayılan 600 sn).",
      },
    },
    required: ["jobId"],
  },
  annotations: { title: "İşi bekle", readOnlyHint: true, openWorldHint: false },
  async run(args, ctx) {
    const jobId = requireStr(args, "jobId");
    const deadline = Date.now() + seconds(args, "timeoutSeconds", 600, 1800) * 1000;
    let lastReported = "";
    for (;;) {
      let job: Job;
      try {
        job = (await api(ctx, "GET", `/api/jobs/${seg(jobId)}`)) as Job;
      } catch (error) {
        if (error instanceof ApiFailure) {
          return jsonResult(
            { httpStatus: error.status, error: error.body },
            (t) => ctx.client.scrub(t),
            0,
            true,
          );
        }
        throw error;
      }
      const progress = typeof job.progress === "number" ? job.progress : 0;
      const key = `${job.status}:${progress}:${job.progressMessage ?? ""}`;
      if (key !== lastReported) {
        lastReported = key;
        await ctx.progress?.(
          Math.round(progress * 100),
          100,
          `${job.status}${job.progressMessage ? `: ${job.progressMessage}` : ""}`,
        );
      }
      if (TERMINAL_JOB.has(job.status)) {
        return jsonResult(
          { done: true, job },
          (t) => ctx.client.scrub(t),
          0,
          job.status === "failed",
        );
      }
      if (Date.now() >= deadline || ctx.signal?.aborted) {
        return jsonResult(
          {
            done: false,
            note: "İş hâlâ sürüyor; studio_wait_job'u yeniden çağırın. (Still running: call again.)",
            job,
          },
          (t) => ctx.client.scrub(t),
        );
      }
      await sleep(timing.pollMs, ctx.signal);
    }
  },
};

// --- chat ---------------------------------------------------------------------------------------

interface MessagePart {
  type: string;
  [key: string]: unknown;
}

interface Message {
  id: string;
  role: string;
  status: string;
  runId: string | null;
  parts: MessagePart[];
  createdAt?: string;
}

interface Run {
  id: string;
  status: string;
  error?: string | null;
  model?: string | null;
}

const ACTIVE_RUN = new Set(["queued", "running"]);

/** Cards waiting for the owner's word in a message. */
function pendingCards(message: Message) {
  const cards: Record<string, unknown>[] = [];
  for (const part of message.parts) {
    if (part.type === "consent" && part.state === "pending") {
      cards.push({
        kind: "consent",
        messageId: message.id,
        consentId: part.consentId,
        tool: part.tool,
        title: part.title,
        detail: part.detail,
      });
    } else if (part.type === "question" && part.answer === null) {
      cards.push({
        kind: "question",
        messageId: message.id,
        questionId: part.questionId,
        prompt: part.prompt,
        mode: part.mode,
        options: part.options,
        allowText: part.allowText,
      });
    } else if (part.type === "approval_request") {
      cards.push({
        kind: "approval_request",
        messageId: message.id,
        approvalId: part.approvalId,
        note: "Görsel onayı: get_approvals_by_id ile okuyun; onay / ret approvals araçlarıyla.",
      });
    }
  }
  return cards;
}

/** A compact view of an assistant message for the agent. */
function summarise(message: Message) {
  const text = message.parts
    .filter((p) => p.type === "text")
    .map((p) => String(p.text ?? ""))
    .join("\n\n");
  const parts = message.parts
    .filter((p) => p.type !== "text")
    .map((p) => {
      if (p.type === "tool_step") {
        return { type: p.type, tool: p.tool, title: p.title, state: p.state };
      }
      return p;
    });
  return { messageId: message.id, status: message.status, text, parts };
}

async function runMessages(ctx: RunContext, conversationId: string, runId: string) {
  const page = (await api(ctx, "GET", `/api/conversations/${seg(conversationId)}/messages`, {
    query: { limit: 20 },
  })) as { items?: Message[] };
  return (page.items ?? []).filter((m) => m.runId === runId && m.role === "assistant").reverse();
}

/** Waits until the run ends or asks the owner something; returns the chat result. */
async function waitForRun(
  ctx: RunContext,
  conversationId: string,
  runId: string,
  timeoutSeconds: number,
): Promise<ToolResult> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastProgress = "";
  let polls = 0;
  for (;;) {
    const run = (await api(ctx, "GET", `/api/agent-runs/${seg(runId)}`)) as Run;
    const messages = await runMessages(ctx, conversationId, runId);
    const waitingFor = messages.flatMap(pendingCards);
    const active = ACTIVE_RUN.has(run.status);
    const latest = messages.at(-1);
    const step = latest?.parts
      .filter((p) => p.type === "progress" || p.type === "tool_step")
      .at(-1);
    const label = step ? String(step.label ?? step.title ?? step.tool ?? "") : run.status;
    if (label !== lastProgress) {
      lastProgress = label;
      polls++;
      await ctx.progress?.(polls, undefined, label);
    }
    const blocking = waitingFor.some((c) => c.kind === "consent" || c.kind === "question");
    if (!active || blocking || Date.now() >= deadline || ctx.signal?.aborted) {
      let state: string;
      if (blocking) state = "waiting_for_owner";
      else if (active) state = "still_running";
      else state = run.status;
      const note =
        state === "waiting_for_owner"
          ? "Ajan sahibin cevabını bekliyor: studio_answer ile yanıtlayın (izin vermek için " +
            "sahibin açık isteği ve confirm: true gerekir). (The agent waits for the owner: use studio_answer.)"
          : state === "still_running"
            ? "Tur hâlâ sürüyor; studio_chat_wait ile beklemeye devam edin. (Still running.)"
            : undefined;
      return jsonResult(
        {
          conversationId,
          runId,
          state,
          ...(note ? { note } : {}),
          run: { status: run.status, model: run.model ?? null, error: run.error ?? null },
          waitingFor,
          reply: messages.map(summarise),
        },
        (t) => ctx.client.scrub(t),
        0,
        run.status === "failed",
      );
    }
    await sleep(timing.pollMs, ctx.signal);
  }
}

const chatTool: CuratedTool = {
  name: "studio_chat",
  title: "Studio sohbeti",
  description:
    "Studio'nun sohbet ajanına sahip olarak mesaj gönderir ve tur bitene kadar bekler; ajanın " +
    "yanıt parçalarını döndürür (metin, içerik bağlantıları, plan önerileri, sorular, izin kartları). " +
    "conversationId verilmezse yeni bir sohbet açılır (brandId önerilir). Ajan izin ya da cevap " +
    "isterse state=waiting_for_owner döner: studio_answer ile yanıtlayın. " +
    "(Send a chat message as the owner, wait for the agent's turn and return its reply.)",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 20000, description: "Mesaj metni." },
      conversationId: id("Var olan sohbet; yoksa yeni sohbet açılır. Existing conversation id."),
      brandId: id("Yeni sohbetin markası. Brand of a new conversation."),
      title: { type: "string", maxLength: 200, description: "Yeni sohbetin başlığı." },
      attachmentAssetIds: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: "Eklenecek varlıklar (önce studio_upload_file ile yükleyin).",
      },
      model: {
        type: "string",
        enum: [
          "opus",
          "sonnet",
          "haiku",
          "gemini-flash-lite",
          "gemini-flash",
          "gemini-pro",
          "codex",
          "gpt",
          "antigravity",
        ],
        description: "Turun modeli (boşsa worker'ın varsayılanı).",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high", "xhigh"],
        description: "Düşünme düzeyi.",
      },
      timeoutSeconds: {
        type: "number",
        minimum: 1,
        maximum: 1800,
        description: "En çok bu kadar bekle (varsayılan 600 sn).",
      },
    },
    required: ["text"],
  },
  annotations: { title: "Studio sohbeti", readOnlyHint: false, openWorldHint: false },
  async run(args, ctx) {
    const text = requireStr(args, "text");
    let conversationId = str(args, "conversationId");
    try {
      if (!conversationId) {
        const created = (await api(ctx, "POST", "/api/conversations", {
          json: {
            ...(str(args, "brandId") ? { brandId: args.brandId } : {}),
            ...(str(args, "title") ? { title: args.title } : {}),
          },
        })) as { id: string };
        conversationId = created.id;
      }
      const body: Record<string, unknown> = { text, clientMessageId: `mcp-${randomUUID()}` };
      if (Array.isArray(args.attachmentAssetIds) && args.attachmentAssetIds.length > 0) {
        body.attachmentAssetIds = args.attachmentAssetIds;
      }
      if (str(args, "model")) body.model = args.model;
      if (str(args, "effort")) body.effort = args.effort;
      const sent = (await api(ctx, "POST", `/api/conversations/${seg(conversationId)}/messages`, {
        json: body,
      })) as { run: Run };
      return await waitForRun(
        ctx,
        conversationId,
        sent.run.id,
        seconds(args, "timeoutSeconds", 600, 1800),
      );
    } catch (error) {
      if (error instanceof ApiFailure) {
        return jsonResult(
          { conversationId: conversationId ?? null, httpStatus: error.status, error: error.body },
          (t) => ctx.client.scrub(t),
          0,
          true,
        );
      }
      throw error;
    }
  },
};

const chatWaitTool: CuratedTool = {
  name: "studio_chat_wait",
  title: "Sohbet turunu bekle",
  description:
    "studio_chat süre dolduğunda (state=still_running) aynı turu beklemeye devam eder. " +
    "(Keep waiting for a chat run.)",
  inputSchema: {
    type: "object",
    properties: {
      conversationId: id("Sohbet kimliği."),
      runId: id("Tur (agent run) kimliği."),
      timeoutSeconds: { type: "number", minimum: 1, maximum: 1800 },
    },
    required: ["conversationId", "runId"],
  },
  annotations: { title: "Sohbet turunu bekle", readOnlyHint: true, openWorldHint: false },
  async run(args, ctx) {
    try {
      return await waitForRun(
        ctx,
        requireStr(args, "conversationId"),
        requireStr(args, "runId"),
        seconds(args, "timeoutSeconds", 600, 1800),
      );
    } catch (error) {
      if (error instanceof ApiFailure) {
        return jsonResult(
          { httpStatus: error.status, error: error.body },
          (t) => ctx.client.scrub(t),
          0,
          true,
        );
      }
      throw error;
    }
  },
};

const answerTool: CuratedTool = {
  name: "studio_answer",
  title: "Karta cevap ver",
  description:
    "Sohbet ajanının sorusunu yanıtlar (questionId + optionIds / text) ya da izin kartına karar " +
    "verir (consentId + allow). İzin VERMEK (allow: true) sahibin adına onaydır: yalnızca sahip " +
    "açıkça istediyse ve confirm: true ile. Reddetmek serbesttir. Ardından tur bitene kadar bekler. " +
    "(Answer a question card, or allow / deny a consent card; allowing needs confirm: true.)",
  inputSchema: {
    type: "object",
    properties: {
      conversationId: id("Sohbet kimliği."),
      messageId: id("Kartın bulunduğu asistan mesajı (waitingFor[].messageId)."),
      consentId: id("İzin kartı (consent) kimliği."),
      allow: { type: "boolean", description: "true = bir kez izin ver, false = reddet." },
      questionId: id("Soru kimliği."),
      optionIds: { type: "array", items: { type: "string" }, maxItems: 12 },
      text: { type: "string", maxLength: 4000, description: "Serbest metin cevap." },
      confirm: {
        type: "boolean",
        description: "allow: true için gerekli; yalnızca sahip açıkça istediyse.",
      },
      wait: { type: "boolean", description: "Cevaptan sonra turu bekle (varsayılan true)." },
      timeoutSeconds: { type: "number", minimum: 1, maximum: 1800 },
    },
    required: ["conversationId", "messageId"],
  },
  annotations: { title: "Karta cevap ver", readOnlyHint: false, destructiveHint: true },
  async run(args, ctx) {
    const conversationId = requireStr(args, "conversationId");
    const messageId = requireStr(args, "messageId");
    const consentId = str(args, "consentId");
    const questionId = str(args, "questionId");
    if (!!consentId === !!questionId) {
      throw new ArgumentError("consentId ya da questionId'den tam olarak biri gerekli");
    }
    const base = `/api/conversations/${seg(conversationId)}/messages/${seg(messageId)}`;
    let runId: string | null = null;
    try {
      if (consentId) {
        if (typeof args.allow !== "boolean")
          throw new ArgumentError("allow (true / false) gerekli");
        if (args.allow && args.confirm !== true) {
          return needsConfirm(
            "studio_answer",
            "ajanın istediği işleme sahibin adına izin verir (allows an agent action as the owner)",
          );
        }
        const result = (await api(ctx, "POST", `${base}/consent`, {
          json: { consentId, allow: args.allow },
        })) as { message: Message };
        runId = result.message.runId;
      } else {
        const body: Record<string, unknown> = {
          questionId,
          optionIds: Array.isArray(args.optionIds) ? args.optionIds : [],
        };
        if (str(args, "text")) body.text = args.text;
        const result = (await api(ctx, "POST", `${base}/answer`, { json: body })) as {
          message: Message;
          run: Run | null;
        };
        runId = result.run?.id ?? result.message.runId;
      }
      if (args.wait === false || !runId) {
        return textResult(`Kaydedildi (recorded).${runId ? ` runId=${runId}` : ""}`);
      }
      return await waitForRun(
        ctx,
        conversationId,
        runId,
        seconds(args, "timeoutSeconds", 600, 1800),
      );
    } catch (error) {
      if (error instanceof ApiFailure) {
        return jsonResult(
          { httpStatus: error.status, error: error.body },
          (t) => ctx.client.scrub(t),
          0,
          true,
        );
      }
      throw error;
    }
  },
};

// --- studio_upload_file -------------------------------------------------------------------------

const uploadTool: CuratedTool = {
  name: "studio_upload_file",
  title: "Dosya yükle",
  description:
    "Bu Mac'teki bir dosyayı markanın varlıklarına yükler (görsel, logo, video, ses, font, PDF). " +
    "Yalnızca ev klasöründeki normal dosyalar; gizli klasörler ve ~/Library reddedilir; en çok 50 MB. " +
    "Dönen asset id sohbete (attachmentAssetIds) ya da içeriklere verilebilir. " +
    "(Upload a local file in your home folder as a brand asset.)",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "Mutlak dosya yolu (ya da ~/...)." },
      brandId: id("Marka kimliği."),
      kind: {
        type: "string",
        enum: ["image", "logo", "video", "audio", "font", "document", "other"],
        description: "Varlık türü (boşsa dosya türünden).",
      },
    },
    required: ["path", "brandId"],
  },
  annotations: { title: "Dosya yükle", readOnlyHint: false, openWorldHint: false },
  async run(args, ctx) {
    const body: Record<string, unknown> = {
      file_path: requireStr(args, "path"),
      brandId: requireStr(args, "brandId"),
    };
    if (str(args, "kind")) body.kind = args.kind;
    let form: FormData;
    try {
      form = buildForm({ fileFields: ["file"] }, body, ctx.homeDir);
    } catch (error) {
      if (error instanceof FileRefused)
        return textResult(`Dosya reddedildi: ${error.message}`, true);
      throw error;
    }
    const res = await ctx.client.request({ method: "POST", path: "/api/assets", form });
    return responseResult(res, (t) => ctx.client.scrub(t), { hint: "upload" });
  },
};

export const CURATED_TOOLS: readonly CuratedTool[] = [
  statusTool,
  chatTool,
  chatWaitTool,
  answerTool,
  waitJobTool,
  brandOverviewTool,
  uploadTool,
];
