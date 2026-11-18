import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  AgentRun,
  AgentRunStatus,
  Asset,
  applyConversationStreamMessage,
  ContentGeneratePayload,
  ContentList,
  Conversation,
  ConversationList,
  type ConversationState,
  ConversationStatus,
  type ConversationStreamMessage,
  decodeConversationStreamMessage,
  decodeMessage,
  encodeMessage,
  ImageSlotExpectation,
  Job,
  type JobDispatchMessage,
  MessageList,
  MessageRole,
  MessageStatus,
  Plan,
  PlanGenerateResult,
  PlanItemStatus,
  type PlanProposalPut,
  PlanProposalResult,
  PlanStatus,
  type ProtocolMessage,
  QuestionAnswerResult,
  TurnContext,
  type TurnOps,
  TurnWriteResult,
  UserMessageResult,
  type WorkerToHubMessage,
} from "@studio/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { ENUMS } from "../src/db/schema.ts";
import { api, BASE, createBrand, expectError, localFetch } from "./helpers.ts";

const hub = () => env.HUB.getByName("main");
const AUTH = () => ({ Authorization: `Bearer ${env.WORKER_TOKEN}` });

/** Worker-side call to the turn API (bearer token). */
async function worker<T = unknown>(method: string, path: string, body?: unknown) {
  const res = await localFetch(`${BASE}${path}`, {
    method,
    headers: { ...AUTH(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = res.headers.get("content-type")?.includes("application/json")
    ? JSON.parse(text)
    : text;
  return { status: res.status, body: parsed as T, headers: res.headers };
}

/** A WebSocket opened through the Worker, with an inbox of decoded frames. */
async function openSocket<M>(path: string, decode: (raw: unknown) => M, headers = {}) {
  const res = await localFetch(`${BASE}${path}`, {
    headers: { Upgrade: "websocket", ...headers },
  });
  if (res.status !== 101) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on response");
  ws.accept();
  const inbox: M[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (event) => {
    inbox.push(decode(event.data));
    for (const wake of waiters.splice(0)) wake();
  });
  async function next(timeoutMs = 2000): Promise<M> {
    const deadline = Date.now() + timeoutMs;
    while (inbox.length === 0) {
      if (Date.now() > deadline) throw new Error("timed out waiting for a frame");
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return inbox.shift() as M;
  }
  return { ws, inbox, next };
}

function decodeStream(raw: unknown): ConversationStreamMessage {
  const decoded = decodeConversationStreamMessage(raw);
  if (!decoded.ok) throw new Error(decoded.error);
  return decoded.message;
}

/** Client following a conversation; `until` drains frames into the reducer. */
async function follow(conversationId: string, after?: number) {
  const socket = await openSocket(
    `/api/conversations/${conversationId}/stream${after !== undefined ? `?after=${after}` : ""}`,
    decodeStream,
  );
  const frames: ConversationStreamMessage[] = [];
  let state: ConversationState | null = null;
  async function take(): Promise<ConversationStreamMessage> {
    const frame = await socket.next();
    frames.push(frame);
    state = applyConversationStreamMessage(state, frame);
    return frame;
  }
  async function until(pred: (m: ConversationStreamMessage) => boolean) {
    for (;;) if (pred(await take())) return;
  }
  return {
    ...socket,
    frames,
    take,
    until,
    get state() {
      return state;
    },
    seqs: () =>
      frames.flatMap((f) =>
        "seq" in f && f.type !== "conversation.snapshot" && f.type !== "conversation.resumed"
          ? [f.seq]
          : [],
      ),
  };
}

let pingSeq = 5000;

/** Fake Mac worker on the hub protocol (only to receive and finish chat.turn jobs). */
async function connectWorker(capabilities = ["chat.turn"], workerId = "mac-chat") {
  const socket = await openSocket(
    "/api/hub",
    (raw) => {
      const decoded = decodeMessage(raw);
      if (!decoded.ok) throw new Error(decoded.error);
      return decoded.message;
    },
    AUTH(),
  );
  const send = (message: WorkerToHubMessage) => socket.ws.send(encodeMessage(message));
  async function sync(): Promise<ProtocolMessage[]> {
    const ts = ++pingSeq;
    send({ type: "ping", ts });
    const got: ProtocolMessage[] = [];
    for (;;) {
      const m = await socket.next();
      if (m.type === "pong" && m.ts === ts) return got;
      got.push(m);
    }
  }
  send({ type: "hello", protocolVersion: 1, workerId, capabilities, activeJobIds: [] });
  const initial = await sync();
  return { ...socket, send, sync, initial };
}

const dispatches = (messages: ProtocolMessage[]) =>
  messages.filter((m): m is JobDispatchMessage => m.type === "job.dispatch");

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
]);

async function uploadAsset(brandId: string): Promise<Asset> {
  const form = new FormData();
  form.set("brandId", brandId);
  form.set("file", new File([PNG], "tarla.png", { type: "image/png" }));
  const res = await localFetch(`${BASE}/api/assets`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return Asset.parse(await res.json());
}

async function newConversation(brandId?: string): Promise<Conversation> {
  const res = await api("POST", "/api/conversations", brandId ? { brandId } : {});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return Conversation.parse(res.body);
}

async function send(conversationId: string, body: Record<string, unknown>) {
  return api("POST", `/api/conversations/${conversationId}/messages`, body);
}

async function sendOk(conversationId: string, text = "MTM için bu ayın postlarını üret") {
  const res = await send(conversationId, { text });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return UserMessageResult.parse(res.body);
}

async function getRun(id: string): Promise<AgentRun> {
  const res = await api("GET", `/api/agent-runs/${id}`);
  expect(res.status).toBe(200);
  return AgentRun.parse(res.body);
}

async function getJob(id: string): Promise<Job> {
  const res = await api("GET", `/api/jobs/${id}`);
  expect(res.status).toBe(200);
  return Job.parse(res.body);
}

async function messagesOf(conversationId: string) {
  const res = await api("GET", `/api/conversations/${conversationId}/messages?limit=100`);
  expect(res.status).toBe(200);
  return MessageList.parse(res.body).items.reverse();
}

const ops = (runId: string, body: TurnOps) => worker("POST", `/api/worker/runs/${runId}/ops`, body);
const start = (runId: string, attempt = 1) =>
  worker("POST", `/api/worker/runs/${runId}/start`, { attempt });

type FakeWorker = Awaited<ReturnType<typeof connectWorker>>;

/** A run the fake worker (a new one, or `w` when its capacity is free) has received, acknowledged and started. */
async function startedRun(conversationId: string, text?: string, existing?: FakeWorker) {
  const sent = await sendOk(conversationId, text);
  const w = existing ?? (await connectWorker());
  const got = existing ? await existing.sync() : w.initial;
  const dispatch = dispatches(got).find((d) => d.job.payload.runId === sent.run.id);
  expect(dispatch, "chat.turn dispatched").toBeDefined();
  const attempt = dispatch?.attempt ?? 1;
  w.send({ type: "job.ack", jobId: sent.run.jobId ?? "", attempt });
  await w.sync();
  const res = await start(sent.run.id, attempt);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { ...sent, worker: w, attempt, context: TurnContext.parse(res.body) };
}

/** The agent completes the run and the worker reports its job done (frees worker capacity). */
async function finishTurn(run: Awaited<ReturnType<typeof startedRun>>) {
  const res = await worker("POST", `/api/worker/runs/${run.run.id}/complete`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  run.worker.send({
    type: "job.result",
    jobId: run.run.jobId ?? "",
    status: "succeeded",
    output: {},
    attempt: run.attempt,
  });
  await run.worker.sync();
}

const decemberPlan = (overrides: Partial<PlanProposalPut> = {}): PlanProposalPut => ({
  title: "Aralık planı",
  periodStart: "2026-12-01",
  periodEnd: "2026-12-31",
  summary: "Kış bakımı ve yeni yıl",
  items: [
    {
      date: "2026-12-03",
      platforms: ["instagram"],
      contentType: "post",
      title: "Kış bakım ipuçları",
      brief: "Toprağı kışa hazırlamak için 3 ipucu",
      pillar: "ipuçları",
      imageSlot: "user_upload",
      imageBrief: "tarlada traktör",
    },
    {
      date: "2026-12-28",
      platforms: ["instagram", "facebook"],
      contentType: "carousel",
      title: "Yılın özeti",
      brief: "2026'da neler yaptık",
      imageSlot: "ai_generate",
    },
  ],
  ...overrides,
});

beforeEach(async () => {
  await abortAllDurableObjects();
  await env.DB.prepare(
    "update jobs set status = 'cancelled', lease_expires_at = null where status in ('queued', 'running')",
  ).run();
  await env.DB.prepare(
    "update agent_runs set status = 'cancelled' where status in ('queued', 'running')",
  ).run();
  await runInDurableObject(hub(), async (_instance, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
  });
});

describe("schema", () => {
  it("keeps chat CHECK enums in sync with the contract", () => {
    const pairs: Array<[readonly string[], readonly string[]]> = [
      [ENUMS.conversationStatus, ConversationStatus.options],
      [ENUMS.messageRole, MessageRole.options],
      [ENUMS.messageStatus, MessageStatus.options],
      [ENUMS.agentRunStatus, AgentRunStatus.options],
      [ENUMS.planStatus, PlanStatus.options],
      [ENUMS.planItemStatus, PlanItemStatus.options],
      [ENUMS.imageSlot, ImageSlotExpectation.options],
    ];
    for (const [db, contract] of pairs) expect([...db]).toEqual([...contract]);
  });

  it("documents the chat routes in OpenAPI", async () => {
    const res = await localFetch(`${BASE}/api/openapi.json`);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    for (const path of [
      "/api/conversations",
      "/api/conversations/{id}",
      "/api/conversations/{id}/messages",
      "/api/conversations/{id}/messages/{messageId}/answer",
      "/api/conversations/{id}/runs",
      "/api/conversations/{id}/stream",
      "/api/agent-runs/{id}/cancel",
      "/api/plans",
      "/api/plans/{id}/accept",
      "/api/plans/{id}/generate",
      "/api/worker/runs/{runId}/start",
      "/api/worker/runs/{runId}/ops",
      "/api/worker/runs/{runId}/plan",
      "/api/worker/runs/{runId}/complete",
    ]) {
      expect(doc.paths, path).toHaveProperty([path]);
    }
  });
});

describe("conversations", () => {
  it("creates, lists by activity, renames, archives and sets the brand once", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const loose = await newConversation();
    expect(loose).toMatchObject({ brandId: null, title: "", status: "active", lastSeq: 0 });
    const branded = await newConversation(brand.id);

    // Sending a message bumps activity: the older conversation moves to the top.
    await sendOk(loose.id, "Merhaba\nikinci satır");
    const list = ConversationList.parse((await api("GET", "/api/conversations?limit=100")).body);
    const order = list.items.map((c) => c.id);
    expect(order.indexOf(loose.id)).toBeLessThan(order.indexOf(branded.id));
    const touched = list.items.find((c) => c.id === loose.id);
    expect(touched?.title).toBe("Merhaba");
    expect(touched?.activeRunId).not.toBeNull();

    const page1 = ConversationList.parse((await api("GET", "/api/conversations?limit=1")).body);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = ConversationList.parse(
      (await api("GET", `/api/conversations?limit=1&cursor=${page1.nextCursor}`)).body,
    );
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);

    const renamed = await api("PATCH", `/api/conversations/${loose.id}`, {
      title: "Aralık",
      brandId: brand.id,
    });
    expect(Conversation.parse(renamed.body)).toMatchObject({ title: "Aralık", brandId: brand.id });
    expectError(
      await api("PATCH", `/api/conversations/${loose.id}`, { brandId: other.id }),
      409,
      "conflict",
    );
    const archived = await api("PATCH", `/api/conversations/${branded.id}`, { status: "archived" });
    expect(Conversation.parse(archived.body).status).toBe("archived");
    expectError(await send(branded.id, { text: "hâlâ burada mısın" }), 409, "conflict");
    const filtered = ConversationList.parse(
      (await api("GET", `/api/conversations?brandId=${brand.id}&status=archived`)).body,
    );
    expect(filtered.items.map((c) => c.id)).toEqual([branded.id]);
    expectError(await api("GET", "/api/conversations/missing"), 404, "not_found");
  });

  it("refuses chat.turn jobs on the generic job endpoint", async () => {
    const err = expectError(
      await api("POST", "/api/jobs", { type: "chat.turn", payload: {} }),
      400,
      "validation_error",
    );
    expect(err.issues?.[0]?.path).toBe("type");
  });
});

describe("happy path", () => {
  it("user message -> run + job -> worker streams text and a plan -> accept -> contents -> generation jobs", async () => {
    const brand = await createBrand({ name: "MTM Agro" });
    const profile = await api("POST", `/api/brands/${brand.id}/profiles`, { voice: "samimi" });
    expect(profile.status).toBe(201);
    expect((await api("POST", `/api/brands/${brand.id}/profiles/1/approve`)).status).toBe(200);
    const skill = (name: string, enabled: boolean) =>
      api("POST", `/api/brands/${brand.id}/skills`, { name, body: `# ${name}`, enabled });
    expect((await skill("mtm", true)).status).toBe(201);
    expect((await skill("kapali", false)).status).toBe(201);
    const asset = await uploadAsset(brand.id);
    const conv = await newConversation(brand.id);

    const client = await follow(conv.id);
    await client.until((m) => m.type === "conversation.snapshot");
    expect(client.state?.seq).toBe(0);
    expect(client.state?.messages).toEqual([]);

    const w = await connectWorker();
    const sendRes = await send(conv.id, {
      text: "MTM için bu ayın postlarını üret, resimleri ben yükleyeceğim",
      attachmentAssetIds: [asset.id],
      clientMessageId: "ios-1",
    });
    expect(sendRes.status, JSON.stringify(sendRes.body)).toBe(201);
    const sent = UserMessageResult.parse(sendRes.body);
    expect(sent.replayed).toBe(false);
    expect(sent.message.parts).toEqual([
      { type: "text", text: "MTM için bu ayın postlarını üret, resimleri ben yükleyeceğim" },
      {
        type: "attachment",
        assetId: asset.id,
        kind: "image",
        mimeType: "image/png",
        width: null,
        height: null,
        filename: "tarla.png",
        alias: "image",
        aliasId: expect.any(String),
      },
    ]);
    expect(sent.run).toMatchObject({
      status: "queued",
      attempt: 0,
      triggerMessageId: sent.message.id,
    });

    // Same clientMessageId: the original comes back, no second run.
    const again = await send(conv.id, { text: "tekrar", clientMessageId: "ios-1" });
    expect(again.status).toBe(200);
    expect(UserMessageResult.parse(again.body)).toMatchObject({
      replayed: true,
      run: { id: sent.run.id },
    });

    // The job went through the normal job path and was dispatched to the worker.
    const jobId = sent.run.jobId ?? "";
    expect(await getJob(jobId)).toMatchObject({
      type: "chat.turn",
      brandId: brand.id,
      priority: 10,
    });
    const [dispatch] = dispatches(await w.sync());
    expect(dispatch?.job).toMatchObject({
      id: jobId,
      type: "chat.turn",
      payload: { conversationId: conv.id, runId: sent.run.id },
    });
    w.send({ type: "job.ack", jobId, attempt: dispatch?.attempt ?? 1 });
    await w.sync();

    const started = await start(sent.run.id, dispatch?.attempt ?? 1);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const context = TurnContext.parse(started.body);
    expect(context.run.status).toBe("running");
    expect(context.brand?.id).toBe(brand.id);
    expect(context.brandProfile).toMatchObject({ version: 1, voice: "samimi" });
    // Only the brand's enabled skills, by name.
    expect(context.brandSkills?.map((s) => s.name)).toEqual(["mtm"]);
    expect(context.messages.map((m) => m.id)).toEqual([sent.message.id]);
    expect(context.assets.map((a) => a.id)).toEqual([asset.id]);
    expect(context.openPlan).toBeNull();
    expect(context.assistantMessage).toBeNull();

    const r1 = await ops(sent.run.id, {
      attempt: 1,
      ops: [
        {
          op: "part.set",
          index: 0,
          part: {
            type: "progress",
            stepId: "profile",
            label: "Marka profili okunuyor",
            state: "running",
          },
        },
        { op: "text.delta", index: 1, seq: 1, text: "Aralık için " },
        { op: "text.delta", index: 1, seq: 2, text: "bir plan hazırladım." },
      ],
    });
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    await ops(sent.run.id, {
      ops: [
        {
          op: "part.set",
          index: 0,
          part: {
            type: "progress",
            stepId: "profile",
            label: "Marka profili okunuyor",
            state: "done",
          },
        },
      ],
    });

    const planRes = await worker("PUT", `/api/worker/runs/${sent.run.id}/plan`, decemberPlan());
    expect(planRes.status, JSON.stringify(planRes.body)).toBe(200);
    const proposal = PlanProposalResult.parse(planRes.body);
    expect(proposal.plan).toMatchObject({ status: "proposed", revision: 1, brandId: brand.id });
    expect(proposal.plan.items.map((i) => [i.position, i.status, i.imageSlot])).toEqual([
      [0, "planned", "user_upload"],
      [1, "planned", "ai_generate"],
    ]);
    expect(proposal.message.parts.at(-1)).toEqual({
      type: "plan_proposal",
      planId: proposal.plan.id,
    });

    // Same plan again: no change (no revision bump, no second card).
    const replay = PlanProposalResult.parse(
      (await worker("PUT", `/api/worker/runs/${sent.run.id}/plan`, decemberPlan())).body,
    );
    expect(replay.plan.revision).toBe(1);
    expect(replay.message.parts).toHaveLength(3);

    const done = await worker("POST", `/api/worker/runs/${sent.run.id}/complete`, {
      attempt: 1,
      model: "claude-opus",
      usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0 },
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(AgentRun.parse(done.body)).toMatchObject({
      status: "completed",
      model: "claude-opus",
      usage: { inputTokens: 1200, outputTokens: 340 },
    });
    // complete is idempotent for retries.
    expect((await worker("POST", `/api/worker/runs/${sent.run.id}/complete`, {})).status).toBe(200);
    w.send({ type: "job.result", jobId, status: "succeeded", output: {}, attempt: 1 });
    await w.sync();
    expect((await getJob(jobId)).status).toBe("succeeded");

    // The client saw every change, in order, with gap-free seqs.
    await client.until((m) => m.type === "run.updated" && m.run.status === "completed");
    await client.until(
      (m) => m.type === "conversation.updated" && m.conversation.activeRunId === null,
    );
    const seqs = client.seqs();
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const types = client.frames.filter((f) => f.type !== "presence").map((f) => f.type);
    expect(types.slice(0, 4)).toEqual([
      "conversation.snapshot",
      "message.created",
      "run.updated",
      "conversation.updated",
    ]);
    expect(types).toContain("text.delta");
    expect(types).toContain("part.updated");
    expect(types).toContain("plan.updated");

    // The reduced stream state equals what the REST API says.
    const state = client.state;
    if (!state) throw new Error("no state");
    expect(state.messages).toEqual(await messagesOf(conv.id));
    const assistant = state.messages[1];
    expect(assistant).toMatchObject({ role: "assistant", status: "complete", runId: sent.run.id });
    expect(assistant?.parts.map((p) => p.type)).toEqual(["progress", "text", "plan_proposal"]);
    expect(assistant?.parts[1]).toEqual({ type: "text", text: "Aralık için bir plan hazırladım." });
    expect(state.activeRun).toBeNull();
    expect(state.plans.map((p) => [p.id, p.status])).toEqual([[proposal.plan.id, "proposed"]]);

    // The user accepts the plan they reviewed.
    expectError(
      await api("POST", `/api/plans/${proposal.plan.id}/accept`, { revision: 7 }),
      409,
      "conflict",
    );
    const accepted = await api("POST", `/api/plans/${proposal.plan.id}/accept`, { revision: 1 });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const plan = Plan.parse(accepted.body);
    expect(plan.status).toBe("accepted");
    expect(plan.items.every((i) => i.status === "accepted" && i.contentId !== null)).toBe(true);
    const contents = ContentList.parse(
      (await api("GET", `/api/contents?brandId=${brand.id}`)).body,
    );
    expect(contents.items.map((c) => [c.title, c.type, c.status]).sort()).toEqual([
      ["Kış bakım ipuçları", "post", "draft"],
      ["Yılın özeti", "carousel", "draft"],
    ]);
    expect(contents.items.every((c) => c.currentVersion === null)).toBe(true);

    // Generation for all accepted items.
    const gen = await api("POST", `/api/plans/${plan.id}/generate`, {
      instructions: "sade",
      model: "sonnet",
      effort: "high",
    });
    expect(gen.status, JSON.stringify(gen.body)).toBe(200);
    const generated = PlanGenerateResult.parse(gen.body);
    expect(generated.jobs).toHaveLength(2);
    for (const job of generated.jobs) {
      expect(job).toMatchObject({ type: "content.generate", status: "queued", brandId: brand.id });
      const payload = ContentGeneratePayload.parse(job.payload);
      const item = plan.items.find((i) => i.contentId === job.contentId);
      expect(payload).toMatchObject({
        brandId: brand.id,
        contentId: item?.contentId,
        brief: item?.brief,
        imageSlot: item?.imageSlot,
        planItem: { planId: plan.id, itemId: item?.id, date: item?.date },
        conversationId: conv.id,
        brandProfileVersion: 1,
        instructions: "sade",
        model: "sonnet",
        effort: "high",
      });
    }
    expect(generated.plan.items.map((i) => i.generation?.status)).toEqual(["queued", "queued"]);
    // Nothing left to generate while they are queued; a named busy item is a conflict.
    expect(
      PlanGenerateResult.parse((await api("POST", `/api/plans/${plan.id}/generate`, {})).body).jobs,
    ).toEqual([]);
    expectError(
      await api("POST", `/api/plans/${plan.id}/generate`, { itemIds: [plan.items[0]?.id] }),
      409,
      "conflict",
    );

    // Job status changes reach the plan card on the stream.
    const firstJob = generated.jobs[0]?.id ?? "";
    expect((await api("POST", `/api/jobs/${firstJob}/cancel`)).status).toBe(200);
    await client.until(
      (m) =>
        m.type === "plan.updated" &&
        m.plan.items.some(
          (i) => i.generation?.jobId === firstJob && i.generation.status === "cancelled",
        ),
    );
    const finalSeqs = client.seqs();
    expect(finalSeqs).toEqual(finalSeqs.map((_, i) => i + 1));
    client.ws.close(1000);
    w.ws.close(1000);
  });
});

describe("rules and edge cases", () => {
  it("keeps the requested model and effort on the run and in the turn context", async () => {
    const conv = await newConversation();
    expectError(await send(conv.id, { text: "selam", model: "gpt-4" }), 400, "validation_error");
    expectError(await send(conv.id, { text: "selam", effort: "max" }), 400, "validation_error");

    const sent = await send(conv.id, { text: "selam", model: "opus", effort: "xhigh" });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    const result = UserMessageResult.parse(sent.body);
    expect(result.run).toMatchObject({ model: "opus", effort: "xhigh" });
    expect(await getRun(result.run.id)).toMatchObject({ model: "opus", effort: "xhigh" });

    const w = await connectWorker();
    const [dispatch] = dispatches(w.initial);
    w.send({ type: "job.ack", jobId: result.run.jobId ?? "", attempt: dispatch?.attempt ?? 1 });
    await w.sync();
    const ctx = TurnContext.parse((await start(result.run.id, dispatch?.attempt ?? 1)).body);
    expect(ctx.run).toMatchObject({ model: "opus", effort: "xhigh" });

    // A question answered after the turn ends starts a turn with the same choice.
    const ask = await ops(result.run.id, {
      ops: [
        {
          op: "part.set",
          index: 0,
          part: { type: "question", questionId: "q", prompt: "Hangisi?", mode: "text" },
        },
      ],
    });
    const messageId = TurnWriteResult.parse(ask.body).message.id;
    await finishTurn({ ...result, worker: w, attempt: dispatch?.attempt ?? 1, context: ctx });
    const answered = await api(
      "POST",
      `/api/conversations/${conv.id}/messages/${messageId}/answer`,
      {
        questionId: "q",
        text: "ilki",
      },
    );
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(QuestionAnswerResult.parse(answered.body).run).toMatchObject({
      model: "opus",
      effort: "xhigh",
    });

    // Without a choice both stay null (worker default).
    const plain = await newConversation();
    expect((await sendOk(plain.id)).run).toMatchObject({ model: null, effort: null });
    w.ws.close(1000);
  });

  it("allows one active run per conversation", async () => {
    const conv = await newConversation();
    const [a, b] = await Promise.all([
      send(conv.id, { text: "bir" }),
      send(conv.id, { text: "iki" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expectError(loser, 409, "conflict");
    expect((await messagesOf(conv.id)).map((m) => m.role)).toEqual(["user"]);

    const first = UserMessageResult.parse((a.status === 201 ? a : b).body);
    expect((await api("POST", `/api/agent-runs/${first.run.id}/cancel`)).status).toBe(200);
    expect((await send(conv.id, { text: "üç" })).status).toBe(201);
  });

  it("cancels a run mid-stream and refuses later writes", async () => {
    const conv = await newConversation();
    const run = await startedRun(conv.id);
    const jobId = run.run.jobId ?? "";
    expect(
      (await ops(run.run.id, { ops: [{ op: "text.delta", index: 0, seq: 1, text: "Yazıyorum" }] }))
        .status,
    ).toBe(200);

    const cancelled = await api("POST", `/api/agent-runs/${run.run.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(AgentRun.parse(cancelled.body).status).toBe("cancelled");
    expect((await api("POST", `/api/agent-runs/${run.run.id}/cancel`)).status).toBe(200); // no-op
    // The worker is told to stop its job.
    expect(await run.worker.sync()).toContainEqual({
      type: "job.cancel",
      jobId,
      reason: "cancelled by user",
    });

    expectError(
      await ops(run.run.id, { ops: [{ op: "text.delta", index: 0, seq: 2, text: " devam" }] }),
      409,
      "invalid_transition",
    );
    expectError(
      await worker("PUT", `/api/worker/runs/${run.run.id}/plan`, decemberPlan()),
      409,
      "invalid_transition",
    );
    expectError(
      await worker("POST", `/api/worker/runs/${run.run.id}/complete`, {}),
      409,
      "invalid_transition",
    );
    expectError(await start(run.run.id, 2), 409, "invalid_transition");

    const [, assistant] = await messagesOf(conv.id);
    expect(assistant).toMatchObject({
      status: "cancelled",
      parts: [{ type: "text", text: "Yazıyorum" }],
    });

    run.worker.send({ type: "job.result", jobId, status: "cancelled", attempt: run.attempt });
    await run.worker.sync();
    expect((await getJob(jobId)).status).toBe("cancelled");
    expect((await getRun(run.run.id)).status).toBe("cancelled");

    // The conversation goes on; a finished run cannot be cancelled.
    const next = await startedRun(conv.id, "yeni", run.worker);
    await finishTurn(next);
    expectError(
      await api("POST", `/api/agent-runs/${next.run.id}/cancel`),
      409,
      "invalid_transition",
    );
    run.worker.ws.close(1000);
  });

  it("applies text deltas exactly once and enforces order, attempts and bounds", async () => {
    const conv = await newConversation();
    const queued = await sendOk(conv.id);
    expectError(
      await ops(queued.run.id, { ops: [{ op: "text.delta", index: 0, seq: 1, text: "erken" }] }),
      409,
      "conflict",
    );
    await api("POST", `/api/agent-runs/${queued.run.id}/cancel`);

    const run = await startedRun(conv.id);
    const id = run.run.id;
    const delta = (seq: number, text: string, index = 0) => ({
      op: "text.delta" as const,
      index,
      seq,
      text,
    });
    expect((await ops(id, { ops: [delta(1, "a")] })).status).toBe(200);
    const dup = await ops(id, { ops: [delta(1, "a")] }); // retry of the same request
    expect(TurnWriteResult.parse(dup.body).message.parts).toEqual([{ type: "text", text: "a" }]);
    expect(
      TurnWriteResult.parse(
        (await ops(id, { ops: [delta(2, "b"), delta(2, "b"), delta(3, "c")] })).body,
      ).message.parts,
    ).toEqual([{ type: "text", text: "abc" }]);
    expectError(await ops(id, { ops: [delta(5, "x")] }), 409, "conflict"); // gap
    expectError(await ops(id, { ops: [delta(1, "x", 3)] }), 409, "conflict"); // part index gap
    expectError(await ops(id, { ops: [delta(2, "x", 1)] }), 409, "conflict"); // new part must start at 1
    // All or nothing: the valid first op is not applied when the second fails.
    expectError(await ops(id, { ops: [delta(4, "d"), delta(9, "z")] }), 409, "conflict");
    expectError(await ops(id, { attempt: 2, ops: [delta(4, "d")] }), 409, "conflict"); // stale attempt
    expectError(
      await ops(id, { ops: [{ op: "part.set", index: 0, part: { type: "error", message: "x" } }] }),
      409,
      "conflict",
    ); // type change
    expectError(await ops(id, { ops: [delta(4, "x".repeat(16_385))] }), 400, "validation_error");
    expectError(await ops(id, { ops: [] }), 400, "validation_error");

    const big = "y".repeat(16_000);
    let seq = 4;
    let last = 200;
    for (let i = 0; i < 7 && last === 200; i++)
      last = (await ops(id, { ops: [delta(seq++, big)] })).status;
    expect(last).toBe(413);
    const assistant = (await messagesOf(conv.id)).find((m) => m.role === "assistant");
    const text = assistant?.parts[0];
    expect(text?.type === "text" && text.text.startsWith("abc")).toBe(true);
    expect(text?.type === "text" && text.text.length).toBeLessThanOrEqual(100_000);
    run.worker.ws.close(1000);
  });

  it("only attaches existing assets of the conversation's brand", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const foreign = await uploadAsset(other.id);
    const mine = await uploadAsset(brand.id);
    const conv = await newConversation(brand.id);

    const wrong = expectError(
      await send(conv.id, { text: "bak", attachmentAssetIds: [mine.id, foreign.id] }),
      400,
      "validation_error",
    );
    expect(wrong.issues?.[0]?.path).toBe("attachmentAssetIds.1");
    expectError(await send(conv.id, { attachmentAssetIds: ["missing"] }), 404, "not_found");
    expectError(await send(conv.id, {}), 400, "validation_error");
    const noBrand = await newConversation();
    expectError(await send(noBrand.id, { attachmentAssetIds: [mine.id] }), 400, "validation_error");
    expect(await messagesOf(conv.id)).toEqual([]);
    expect((await send(conv.id, { attachmentAssetIds: [mine.id] })).status).toBe(201);

    // The agent cannot attach another brand's asset either.
    await api("POST", `/api/agent-runs/${(await getConversation(conv.id)).activeRunId}/cancel`);
    const run = await startedRun(conv.id);
    expectError(
      await ops(run.run.id, {
        ops: [{ op: "part.set", index: 0, part: { type: "attachment", assetId: foreign.id } }],
      }),
      400,
      "validation_error",
    );
    run.worker.ws.close(1000);
  });

  it("resumes a stream from the last seen seq, also after a Hub restart", async () => {
    const conv = await newConversation();
    const run = await startedRun(conv.id);
    const first = await follow(conv.id);
    await first.until((m) => m.type === "conversation.snapshot");
    const seenSeq = first.state?.seq ?? 0;
    expect(seenSeq).toBeGreaterThan(0);
    await ops(run.run.id, { ops: [{ op: "text.delta", index: 0, seq: 1, text: "bir " }] });
    await first.until((m) => m.type === "text.delta");
    const afterFirst = first.state?.seq ?? 0;
    first.ws.close(1000);

    // Missed while disconnected.
    await ops(run.run.id, { ops: [{ op: "text.delta", index: 0, seq: 2, text: "iki " }] });
    await ops(run.run.id, { ops: [{ op: "text.delta", index: 0, seq: 3, text: "üç" }] });

    const back = await follow(conv.id, afterFirst);
    await back.until((m) => m.type === "conversation.resumed");
    expect(back.frames.map((f) => f.type)).toEqual([
      "text.delta",
      "text.delta",
      "conversation.resumed",
    ]);
    expect(back.seqs()).toEqual([afterFirst + 1, afterFirst + 2]);
    back.ws.close(1000);

    // Hub restart: sockets and memory gone, the log in D1 is not.
    await abortAllDurableObjects();
    const afterRestart = await follow(conv.id, seenSeq);
    await afterRestart.until((m) => m.type === "conversation.resumed");
    expect(afterRestart.seqs()).toEqual([seenSeq + 1, seenSeq + 2, seenSeq + 3, seenSeq + 4]);

    // Applying the replay on top of the old state gives the full text.
    let state = first.state;
    for (const frame of afterRestart.frames) state = applyConversationStreamMessage(state, frame);
    // `first` already had the first delta, so its seq filters the duplicate.
    expect(state?.messages.at(-1)?.parts).toEqual([{ type: "text", text: "bir iki üç" }]);
    expect(state?.stale).toBe(false);

    // Live events keep flowing on the resumed socket.
    await worker("POST", `/api/worker/runs/${run.run.id}/complete`, {});
    await afterRestart.until((m) => m.type === "run.updated" && m.run.status === "completed");

    // An unknown (future) seq falls back to a snapshot.
    const future = await follow(conv.id, 10_000);
    const snap = await future.take();
    expect(snap.type).toBe("conversation.snapshot");
    expect(snap.type === "conversation.snapshot" && snap.messages.at(-1)?.status).toBe("complete");
    afterRestart.ws.close(1000);
    future.ws.close(1000);
    run.worker.ws.close(1000);

    expect((await localFetch(`${BASE}/api/conversations/${conv.id}/stream`)).status).toBe(426);
    const missing = await localFetch(`${BASE}/api/conversations/nope/stream`, {
      headers: { Upgrade: "websocket" },
    });
    expect(missing.status).toBe(404);
  });

  it("answers a question and starts the next turn", async () => {
    const conv = await newConversation();
    const run = await startedRun(conv.id);
    const ask = await ops(run.run.id, {
      ops: [
        {
          op: "part.set",
          index: 0,
          part: {
            type: "question",
            questionId: "count",
            prompt: "Bu ay kaç post olsun?",
            mode: "single",
            options: [
              { id: "8", label: "8 post" },
              { id: "12", label: "12 post" },
            ],
            allowText: true,
          },
        },
      ],
    });
    expect(ask.status, JSON.stringify(ask.body)).toBe(200);
    const messageId = TurnWriteResult.parse(ask.body).message.id;
    await finishTurn(run);

    const url = `/api/conversations/${conv.id}/messages/${messageId}/answer`;
    expectError(
      await api("POST", url, { questionId: "count", optionIds: ["99"] }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", url, { questionId: "count", optionIds: ["8", "12"] }),
      400,
      "validation_error",
    );
    expectError(await api("POST", url, { questionId: "nope", optionIds: ["8"] }), 404, "not_found");
    const answered = await api("POST", url, { questionId: "count", optionIds: ["12"] });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const result = QuestionAnswerResult.parse(answered.body);
    expect(result.message.parts[0]).toMatchObject({ answer: { optionIds: ["12"], text: null } });
    expect(result.run).toMatchObject({ status: "queued", triggerMessageId: messageId });
    // Same answer again: no-op; a different one: conflict.
    expect(
      QuestionAnswerResult.parse(
        (await api("POST", url, { questionId: "count", optionIds: ["12"] })).body,
      ).run,
    ).toBeNull();
    expectError(await api("POST", url, { questionId: "count", optionIds: ["8"] }), 409, "conflict");

    // The next turn sees the answer in its context.
    const [dispatch] = dispatches(await run.worker.sync());
    expect(dispatch?.job.payload).toEqual({ conversationId: conv.id, runId: result.run?.id });
    const ctx = TurnContext.parse((await start(result.run?.id ?? "", dispatch?.attempt ?? 1)).body);
    expect(ctx.messages.at(-1)?.parts[0]).toMatchObject({
      type: "question",
      answer: { optionIds: ["12"] },
    });
    run.worker.ws.close(1000);
  });

  it("lets the user edit and reject plans, and supersedes older proposals", async () => {
    const brand = await createBrand();
    const conv = await newConversation(); // brand-less: the agent sets it with the plan
    const run = await startedRun(conv.id);
    expectError(
      await worker("PUT", `/api/worker/runs/${run.run.id}/plan`, decemberPlan()),
      400,
      "validation_error",
    );
    expectError(
      await worker("PUT", `/api/worker/runs/${run.run.id}/plan`, {
        ...decemberPlan({ brandId: brand.id }),
        periodEnd: "2026-11-30",
      }),
      400,
      "validation_error",
    );
    const first = PlanProposalResult.parse(
      (
        await worker(
          "PUT",
          `/api/worker/runs/${run.run.id}/plan`,
          decemberPlan({ brandId: brand.id }),
        )
      ).body,
    );
    expect((await getConversation(conv.id)).brandId).toBe(brand.id);
    // Replacing the run's own plan keeps its id and bumps the revision.
    const replaced = PlanProposalResult.parse(
      (await worker("PUT", `/api/worker/runs/${run.run.id}/plan`, decemberPlan({ summary: "v2" })))
        .body,
    );
    expect(replaced.plan).toMatchObject({ id: first.plan.id, revision: 2, summary: "v2" });
    await finishTurn(run);

    // User edit: keep the second item, drop the first, add a new one.
    const keep = replaced.plan.items[1];
    expectError(
      await api("PATCH", `/api/plans/${first.plan.id}`, { revision: 1, summary: "x" }),
      409,
      "conflict",
    );
    const edited = await api("PATCH", `/api/plans/${first.plan.id}`, {
      revision: 2,
      items: [
        {
          id: keep?.id,
          date: "2026-12-30",
          platforms: ["instagram"],
          contentType: "carousel",
          title: "Yılın özeti (kısa)",
        },
        {
          date: "2026-12-15",
          platforms: ["linkedin"],
          contentType: "post",
          title: "Ekip tanıtımı",
        },
      ],
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const plan = Plan.parse(edited.body);
    expect(plan.revision).toBe(3);
    expect(plan.items.map((i) => [i.title, i.id === keep?.id])).toEqual([
      ["Yılın özeti (kısa)", true],
      ["Ekip tanıtımı", false],
    ]);
    expectError(
      await api("PATCH", `/api/plans/${plan.id}`, {
        revision: 3,
        items: [
          { date: "2027-01-02", platforms: ["instagram"], contentType: "post", title: "Ocak" },
        ],
      }),
      400,
      "validation_error",
    );

    // A new turn proposes another plan: the old one is superseded.
    const run2 = await startedRun(conv.id, "Yeniden planla", run.worker);
    const second = PlanProposalResult.parse(
      (await worker("PUT", `/api/worker/runs/${run2.run.id}/plan`, decemberPlan())).body,
    );
    expect(second.plan.id).not.toBe(first.plan.id);
    expect(Plan.parse((await api("GET", `/api/plans/${first.plan.id}`)).body).status).toBe(
      "superseded",
    );
    expectError(
      await api("POST", `/api/plans/${first.plan.id}/accept`, { revision: 3 }),
      409,
      "invalid_transition",
    );

    const rejected = await api("POST", `/api/plans/${second.plan.id}/reject`, {
      reason: "çok yoğun",
    });
    expect(Plan.parse(rejected.body)).toMatchObject({
      status: "rejected",
      rejectionReason: "çok yoğun",
    });
    expectError(
      await api("POST", `/api/plans/${second.plan.id}/generate`, {}),
      409,
      "invalid_transition",
    );
    const listed = await api("GET", `/api/plans?conversationId=${conv.id}`);
    expect((listed.body as { items: Plan[] }).items.map((p) => p.status)).toEqual([
      "rejected",
      "superseded",
    ]);
    run.worker.ws.close(1000);
  });

  it("ends the run when its job fails or is requeued without the worker closing it", async () => {
    const conv = await newConversation();
    const run = await startedRun(conv.id);
    const jobId = run.run.jobId ?? "";
    await ops(run.run.id, { ops: [{ op: "text.delta", index: 0, seq: 1, text: "yarım" }] });

    // The worker loses the job: lease expires, the job is requeued (attempt 2 allowed).
    run.worker.ws.close(1000);
    await env.DB.prepare("update jobs set lease_expires_at = ? where id = ?")
      .bind(Date.now() - 1000, jobId)
      .run();
    await runDurableObjectAlarm(hub());
    expect((await getJob(jobId)).status).toBe("queued");
    expect((await getRun(run.run.id)).status).toBe("queued");

    // Attempt 2 starts the assistant message over.
    const w2 = await connectWorker();
    const [dispatch] = dispatches(w2.initial);
    expect(dispatch?.attempt).toBe(2);
    w2.send({ type: "job.ack", jobId, attempt: 2 });
    await w2.sync();
    const ctx = TurnContext.parse((await start(run.run.id, 2)).body);
    expect(ctx.assistantMessage).toMatchObject({ parts: [], status: "streaming" });
    expectError(
      await ops(run.run.id, {
        attempt: 1,
        ops: [{ op: "text.delta", index: 0, seq: 1, text: "eski" }],
      }),
      409,
      "conflict",
    );

    // The handler crashes: the job fails, so does the run, with the error in the chat.
    w2.send({
      type: "job.result",
      jobId,
      status: "failed",
      error: "claude exited with code 1",
      attempt: 2,
    });
    await w2.sync();
    expect(await getRun(run.run.id)).toMatchObject({
      status: "failed",
      error: "claude exited with code 1",
    });
    const [, assistant] = await messagesOf(conv.id);
    expect(assistant).toMatchObject({
      status: "failed",
      parts: [{ type: "error", message: "claude exited with code 1" }],
    });
    w2.ws.close(1000);
  });

  it("requires the worker token on the turn API", async () => {
    const conv = await newConversation();
    const sent = await sendOk(conv.id);
    const noToken = await localFetch(`${BASE}/api/worker/runs/${sent.run.id}/context`);
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get("www-authenticate")).toBe("Bearer");
    const wrong = await localFetch(`${BASE}/api/worker/runs/${sent.run.id}/context`, {
      headers: { Authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    const ok = await worker("GET", `/api/worker/runs/${sent.run.id}/context`);
    expect(ok.status).toBe(200);
    expect(TurnContext.parse(ok.body).run.status).toBe("queued");
    expectError(await worker("GET", "/api/worker/runs/missing/context"), 404, "not_found");
  });
});

async function getConversation(id: string): Promise<Conversation> {
  const res = await api("GET", `/api/conversations/${id}`);
  expect(res.status).toBe(200);
  return Conversation.parse(res.body);
}
