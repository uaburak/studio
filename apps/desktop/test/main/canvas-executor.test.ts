// The Mac app's canvas runner on the hub (S1): it announces only the canvas job types, runs one
// job at a time in the hidden page (a fake here), speaks the worker protocol (ack, progress,
// heartbeat, result kept until acknowledged and resent after a reconnect, cancel, hand back on
// quit), ignores the Mac worker's commands and follows the host (connects when it is up, moves
// with its port).
import {
  decodeMessage,
  encodeMessage,
  type HubToWorkerMessage,
  type Job,
  type ProtocolMessage,
} from "@studio/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CanvasExecutor,
  type CanvasJobContext,
  type HubSocketEvents,
  type HubTarget,
} from "../../src/main/canvas/executor.ts";

interface FakeSocket {
  url: string;
  token: string;
  events: HubSocketEvents;
  sent: ProtocolMessage[];
  closed: boolean;
  /** The hub sends a frame. */
  push(message: HubToWorkerMessage): void;
}

function harness(target: HubTarget | null = { url: "ws://127.0.0.1:8790/api/hub", token: "t0k" }) {
  const sockets: FakeSocket[] = [];
  const runs: {
    job: Job;
    ctx: CanvasJobContext;
    resolve(o: Record<string, unknown>): void;
    reject(e: Error): void;
  }[] = [];
  const state = { target };
  const executor = new CanvasExecutor({
    workerId: "studio-canvas",
    version: "0.1.0",
    target: () => state.target,
    heartbeatMs: 1_000,
    pingMs: 60_000,
    retryMs: () => 500,
    socket: (url, token, events) => {
      const socket: FakeSocket = {
        url,
        token,
        events,
        sent: [],
        closed: false,
        push: (message) => events.onMessage(encodeMessage(message)),
      };
      sockets.push(socket);
      return {
        send: (data) => {
          const decoded = decodeMessage(data);
          if (!decoded.ok) throw new Error(decoded.error);
          socket.sent.push(decoded.message);
        },
        close: () => {
          socket.closed = true;
        },
      };
    },
    runner: {
      run: (job, ctx) =>
        new Promise((resolve, reject) => {
          runs.push({ job, ctx, resolve, reject });
        }),
    },
  });
  return { executor, sockets, runs, state };
}

const job = (id: string, type: Job["type"] = "canvas.apply"): Job =>
  ({
    id,
    type,
    status: "running",
    payload: { version: 2, operations: [{ tool: "update_nodes", args: {} }] },
    brandId: "b1",
    contentId: "p1",
    createdAt: "2026-11-18T10:00:00.000Z",
    updatedAt: "2026-11-18T10:00:00.000Z",
  }) as Job;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe("canvas runner on the hub", () => {
  it("announces only the canvas jobs and runs one: ack, progress, result until acknowledged", async () => {
    const { executor, sockets, runs } = harness();
    executor.start();
    const socket = sockets[0] as FakeSocket;
    expect(socket).toMatchObject({ url: "ws://127.0.0.1:8790/api/hub", token: "t0k" });
    socket.events.onOpen();
    expect(socket.sent[0]).toEqual({
      type: "hello",
      protocolVersion: 1,
      workerId: "studio-canvas",
      capabilities: ["canvas.read", "canvas.apply", "canvas.create"],
      workerVersion: "0.1.0",
      concurrency: 1,
      activeJobIds: [],
    });
    socket.push({ type: "job.dispatch", job: job("j1"), attempt: 1 });
    expect(socket.sent[1]).toEqual({ type: "job.ack", jobId: "j1", attempt: 1 });
    expect(runs).toHaveLength(1);
    expect(executor.running).toBe("j1");
    runs[0]?.ctx.progress(0.3, "Wecra işlemleri uygulanıyor");
    expect(socket.sent[2]).toEqual({
      type: "job.progress",
      jobId: "j1",
      progress: 0.3,
      message: "Wecra işlemleri uygulanıyor",
      attempt: 1,
    });
    // A second dispatch while one runs goes back to the hub.
    socket.push({ type: "job.dispatch", job: job("j2"), attempt: 1 });
    expect(socket.sent[3]).toEqual({
      type: "job.release",
      jobId: "j2",
      attempt: 1,
      reason: "busy",
    });
    // The Mac worker's commands are not the runner's; pings are answered.
    socket.push({ type: "worker.command", command: "claude.login" });
    socket.push({ type: "ping", ts: 5 });
    expect(socket.sent.at(-1)).toEqual({ type: "pong", ts: 5 });
    runs[0]?.resolve({ version: 3 });
    await flush();
    const result = {
      type: "job.result",
      jobId: "j1",
      status: "succeeded",
      output: { version: 3 },
      attempt: 1,
    };
    expect(socket.sent.at(-1)).toEqual(result);
    expect(executor.running).toBeNull();

    // Not acknowledged: resent after a reconnect, listed as held in the new hello.
    socket.events.onClose(1006, "gone");
    expect(sockets).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 520));
    const again = sockets[1] as FakeSocket;
    again.events.onOpen();
    expect(again.sent[0]).toMatchObject({ type: "hello", activeJobIds: ["j1"] });
    expect(again.sent[1]).toEqual(result);
    again.push({ type: "job.result.ack", jobId: "j1" });
    again.push({ type: "job.dispatch", job: job("j1"), attempt: 1 });
    // Acknowledged: forgotten (a stray dispatch of it runs again).
    expect(runs).toHaveLength(2);
    executor.stop();
  });

  it("fails a job with the page's message; a cancel ends it as cancelled", async () => {
    const { executor, sockets, runs } = harness();
    executor.start();
    const socket = sockets[0] as FakeSocket;
    socket.events.onOpen();
    socket.push({ type: "job.dispatch", job: job("j1"), attempt: 2 });
    runs[0]?.reject(new Error("Post değişti: güncel sürüm v3"));
    await flush();
    expect(socket.sent.at(-1)).toEqual({
      type: "job.result",
      jobId: "j1",
      status: "failed",
      error: "Post değişti: güncel sürüm v3",
      attempt: 2,
    });
    socket.push({ type: "job.dispatch", job: job("j2", "canvas.read"), attempt: 1 });
    const second = runs[1];
    socket.push({ type: "job.cancel", jobId: "j2" });
    expect(second?.ctx.signal.aborted).toBe(true);
    second?.reject(new Error("İptal edildi."));
    await flush();
    expect(socket.sent.at(-1)).toEqual({
      type: "job.result",
      jobId: "j2",
      status: "cancelled",
      attempt: 1,
    });
    executor.stop();
  });

  it("heartbeats the running job; quitting hands it back", async () => {
    vi.useFakeTimers();
    const { executor, sockets, runs } = harness();
    executor.start();
    const socket = sockets[0] as FakeSocket;
    socket.events.onOpen();
    socket.push({ type: "job.dispatch", job: job("j1"), attempt: 1 });
    vi.advanceTimersByTime(1_000);
    expect(socket.sent.at(-1)).toEqual({ type: "job.heartbeat", jobIds: ["j1"] });
    executor.stop();
    expect(runs[0]?.ctx.signal.aborted).toBe(true);
    expect(socket.sent.at(-1)).toEqual({
      type: "job.release",
      jobId: "j1",
      attempt: 1,
      reason: "app quit",
    });
    expect(socket.closed).toBe(true);
    runs[0]?.reject(new Error("aborted"));
    await vi.runAllTimersAsync();
    // Handed back: no result of its own.
    expect(socket.sent.filter((m) => m.type === "job.result")).toEqual([]);
  });

  it("follows the host: waits while it is down, connects when it is up, moves with its port", () => {
    const { executor, sockets, state } = harness(null);
    executor.start();
    expect(sockets).toHaveLength(0);
    state.target = { url: "ws://127.0.0.1:8790/api/hub", token: "a" };
    executor.refresh();
    expect(sockets).toHaveLength(1);
    executor.refresh();
    expect(sockets).toHaveLength(1);
    state.target = { url: "ws://127.0.0.1:8795/api/hub", token: "a" };
    executor.refresh();
    expect(sockets[0]?.closed).toBe(true);
    expect(sockets[1]?.url).toBe("ws://127.0.0.1:8795/api/hub");
    state.target = null;
    executor.refresh();
    expect(sockets[1]?.closed).toBe(true);
    executor.stop();
  });
});
