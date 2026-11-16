import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  ClaudeControl,
  ConsentDecisionResult,
  Conversation,
  decodeMessage,
  encodeMessage,
  type JobDispatchMessage,
  type ProtocolMessage,
  TurnContext,
  TurnMessageResult,
  TurnWriteResult,
  UserMessageResult,
  WorkerPresence,
  type WorkerToHubMessage,
} from "@studio/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { api, BASE, expectError, localFetch } from "./helpers.ts";

/*
 * Task A5 additions: `tool_step` and `consent` parts, the consent endpoint, the agent session
 * stored on the conversation, the worker's message read, and the Mac's Claude sign-in control.
 */

const hub = () => env.HUB.getByName("main");
const AUTH = () => ({ Authorization: `Bearer ${env.WORKER_TOKEN}` });

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
  return { status: res.status, body: parsed as T };
}

let pingSeq = 9000;

async function connectWorker(workerId = "mac-a5") {
  const res = await localFetch(`${BASE}/api/hub`, { headers: { Upgrade: "websocket", ...AUTH() } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`upgrade failed: ${res.status}`);
  ws.accept();
  const inbox: ProtocolMessage[] = [];
  ws.addEventListener("message", (event) => {
    const decoded = decodeMessage(event.data);
    if (decoded.ok) inbox.push(decoded.message);
  });
  const send = (m: WorkerToHubMessage) => ws.send(encodeMessage(m));
  async function sync(): Promise<ProtocolMessage[]> {
    const ts = ++pingSeq;
    send({ type: "ping", ts });
    const got: ProtocolMessage[] = [];
    const deadline = Date.now() + 3000;
    for (;;) {
      const m = inbox.shift();
      if (!m) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      if (m.type === "pong" && m.ts === ts) return got;
      got.push(m);
    }
  }
  send({
    type: "hello",
    protocolVersion: 1,
    workerId,
    capabilities: ["chat.turn"],
    activeJobIds: [],
  });
  const initial = await sync();
  return { ws, send, sync, initial };
}

async function newConversation(): Promise<Conversation> {
  const res = await api("POST", "/api/conversations", {});
  expect(res.status).toBe(201);
  return Conversation.parse(res.body);
}

/** A user message whose run the fake worker received, acked and started. */
async function startedRun(conversationId: string, w: Awaited<ReturnType<typeof connectWorker>>) {
  const sent = await api("POST", `/api/conversations/${conversationId}/messages`, {
    text: "Merhaba",
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  const result = UserMessageResult.parse(sent.body);
  const dispatch = (await w.sync()).find(
    (m): m is JobDispatchMessage =>
      m.type === "job.dispatch" && m.job.payload.runId === result.run.id,
  );
  const attempt = dispatch?.attempt ?? 1;
  w.send({ type: "job.ack", jobId: result.run.jobId ?? "", attempt });
  await w.sync();
  const start = await worker("POST", `/api/worker/runs/${result.run.id}/start`, { attempt });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
  return { ...result, attempt, context: TurnContext.parse(start.body) };
}

async function finishJob(
  w: Awaited<ReturnType<typeof connectWorker>>,
  run: { run: { jobId: string | null }; attempt: number },
) {
  w.send({
    type: "job.result",
    jobId: run.run.jobId ?? "",
    status: "succeeded",
    output: {},
    attempt: run.attempt,
  });
  await w.sync();
}

const ops = (runId: string, body: unknown) => worker("POST", `/api/worker/runs/${runId}/ops`, body);

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

describe("tool steps and consent cards", () => {
  it("writes and updates tool_step parts, and the owner allows a consent card the run holds", async () => {
    const conv = await newConversation();
    const w = await connectWorker();
    const run = await startedRun(conv.id, w);
    const step = {
      type: "tool_step",
      id: "toolu_01",
      name: "schedule_post",
      label: "Zamanlama için izin bekleniyor…",
      state: "running",
    };
    const card = {
      type: "consent",
      consentId: "consent-1",
      tool: "schedule_post",
      title: "Postu zamanla",
      detail: "Kasım kampanyası · Instagram · 20 Kasım 10:00",
    };
    const wrote = await ops(run.run.id, {
      ops: [
        { op: "part.set", index: 0, part: step },
        { op: "part.set", index: 1, part: card },
      ],
    });
    expect(wrote.status, JSON.stringify(wrote.body)).toBe(200);
    const message = TurnWriteResult.parse(wrote.body).message;
    expect(message.parts).toEqual([
      { ...step, summary: null },
      { ...card, state: "pending", decidedAt: null },
    ]);

    // The worker polls the run's message while it waits.
    const polled = TurnMessageResult.parse(
      (await worker("GET", `/api/worker/runs/${run.run.id}/message`)).body,
    );
    expect(polled.run.status).toBe("running");
    expect(polled.message?.parts[1]).toMatchObject({ type: "consent", state: "pending" });

    const url = `/api/conversations/${conv.id}/messages/${message.id}/consent`;
    expectError(await api("POST", url, { consentId: "nope", allow: true }), 404, "not_found");
    const allowed = await api("POST", url, { consentId: "consent-1", allow: true });
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    const decided = ConsentDecisionResult.parse(allowed.body).message.parts[1];
    expect(decided).toMatchObject({ type: "consent", state: "allowed" });
    expect(decided?.type === "consent" && decided.decidedAt).toBeTruthy();
    // Same decision again: no-op; the other one: conflict.
    expect((await api("POST", url, { consentId: "consent-1", allow: true })).status).toBe(200);
    expectError(await api("POST", url, { consentId: "consent-1", allow: false }), 409, "conflict");
    // A worker retry of the pending card (or a late expiry) does not undo the owner's answer.
    const retry = await ops(run.run.id, {
      ops: [{ op: "part.set", index: 1, part: { ...card, state: "expired" } }],
    });
    expect(retry.status).toBe(200);
    expect(TurnWriteResult.parse(retry.body).message.parts[1]).toMatchObject({ state: "allowed" });
    // The step is replaced in place when the call ends.
    const done = await ops(run.run.id, {
      ops: [
        {
          op: "part.set",
          index: 0,
          part: { ...step, label: "Post zamanlandı", state: "done", summary: "instagram · 10:00" },
        },
      ],
    });
    expect(TurnWriteResult.parse(done.body).message.parts[0]).toMatchObject({
      label: "Post zamanlandı",
      state: "done",
    });
    const complete = await worker("POST", `/api/worker/runs/${run.run.id}/complete`, {});
    expect(complete.status).toBe(200);
    await finishJob(w, run);
    w.ws.close(1000);
  });

  it("expires an unanswered card when the run ends, and refuses a late answer", async () => {
    const conv = await newConversation();
    const w = await connectWorker();
    const run = await startedRun(conv.id, w);
    const wrote = await ops(run.run.id, {
      ops: [
        {
          op: "part.set",
          index: 0,
          part: { type: "consent", consentId: "c2", tool: "approve_post", title: "Postu onayla" },
        },
      ],
    });
    const messageId = TurnWriteResult.parse(wrote.body).message.id;
    // The owner stops the run while the card waits.
    expect((await api("POST", `/api/agent-runs/${run.run.id}/cancel`)).status).toBe(200);
    const msgs = await api("GET", `/api/conversations/${conv.id}/messages?limit=10`);
    const assistant = (msgs.body as { items: { id: string; parts: unknown[] }[] }).items.find(
      (m) => m.id === messageId,
    );
    expect(assistant?.parts[0]).toMatchObject({ type: "consent", state: "expired" });
    expectError(
      await api("POST", `/api/conversations/${conv.id}/messages/${messageId}/consent`, {
        consentId: "c2",
        allow: true,
      }),
      409,
      "conflict",
    );
    w.ws.close(1000);
  });
});

describe("agent session on the conversation", () => {
  it("stores the session with the message count at completion; the next turn sees it", async () => {
    const conv = await newConversation();
    expect(conv.agentSession).toBeNull();
    const w = await connectWorker();
    const first = await startedRun(conv.id, w);
    expect(first.context.messageCount).toBe(1);
    await ops(first.run.id, { ops: [{ op: "text.delta", index: 0, seq: 1, text: "Selam" }] });
    const done = await worker("POST", `/api/worker/runs/${first.run.id}/complete`, {
      session: { id: "sess-abc" },
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    await finishJob(w, first);
    const after = Conversation.parse((await api("GET", `/api/conversations/${conv.id}`)).body);
    expect(after.agentSession).toMatchObject({
      id: "sess-abc",
      messageCount: 2,
      runId: first.run.id,
    });

    const second = await startedRun(conv.id, w);
    // Session current: it covered 2 messages, the conversation has 3 (+ the new user message).
    expect(second.context.conversation.agentSession?.id).toBe("sess-abc");
    expect(second.context.messageCount).toBe(3);
    // A completion without a session keeps the stored one.
    await worker("POST", `/api/worker/runs/${second.run.id}/complete`, {});
    await finishJob(w, second);
    const kept = Conversation.parse((await api("GET", `/api/conversations/${conv.id}`)).body);
    expect(kept.agentSession?.id).toBe("sess-abc");
    w.ws.close(1000);
  });
});

describe("Claude sign-in control", () => {
  it("shows the worker's report in presence and forwards login/status commands", async () => {
    const before = ClaudeControl.parse((await api("GET", "/api/workers/claude")).body);
    expect(before).toEqual({ account: null, online: false, sent: 0 });
    expectError(await api("POST", "/api/workers/claude/login"), 409, "conflict");

    const w = await connectWorker("mac-claude");
    const account = {
      status: "signed_out" as const,
      email: null,
      plan: null,
      cliVersion: "2.1.292",
      loginUrl: null,
      detail: "Claude oturumu kapalı.",
      checkedAt: new Date().toISOString(),
    };
    w.send({ type: "worker.claude", account });
    await w.sync();
    const presence = WorkerPresence.parse((await api("GET", "/api/workers/presence")).body);
    expect(presence.claude).toEqual(account);

    const login = await api("POST", "/api/workers/claude/login");
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    expect(ClaudeControl.parse(login.body)).toMatchObject({ online: true, sent: 1, account });
    const status = await api("POST", "/api/workers/claude/status");
    expect(status.status).toBe(200);
    const got = await w.sync();
    expect(got.filter((m) => m.type === "worker.command")).toEqual([
      { type: "worker.command", command: "claude.login" },
      { type: "worker.command", command: "claude.status" },
    ]);

    // Only the Mac itself may start a sign-in (a paired phone or the worker token may not).
    const remote = await exports.default.fetch(`${BASE}/api/workers/claude/login`, {
      method: "POST",
      headers: AUTH(),
    });
    expect(remote.status).toBe(403);
    w.ws.close(1000);
  });
});
