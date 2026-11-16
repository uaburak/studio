import type { Job } from "@studio/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../src/config.ts";
import { HubConnection } from "../src/connection.ts";
import { silentLogger } from "../src/log.ts";
import { startWorker } from "../src/worker.ts";
import { fakeSocketFactory } from "./fake-socket.ts";

const config: WorkerConfig = {
  hubUrl: "ws://hub.test/api/hub",
  workerId: "mac-test",
  backoff: { baseMs: 100, maxMs: 1000, jitter: 0 },
  pingIntervalMs: 5000,
  logLevel: "error",
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("HubConnection", () => {
  it("sends hello on open", () => {
    const fake = fakeSocketFactory();
    const conn = startWorker({ config, logger: silentLogger, socketFactory: fake.factory });
    fake.last()?.simulateOpen();
    expect(fake.last()?.sent[0]).toEqual({
      type: "hello",
      protocolVersion: 1,
      workerId: "mac-test",
      capabilities: ["demo.echo"],
      workerVersion: "0.0.0",
    });
    expect(conn.state).toBe("connected");
    conn.stop();
  });

  it("reconnects with exponential backoff and resets after success", () => {
    const fake = fakeSocketFactory();
    const conn = startWorker({ config, logger: silentLogger, socketFactory: fake.factory });
    expect(fake.sockets).toHaveLength(1);

    // Three failed attempts: delays 100, 200, 400.
    for (const [i, delay] of [100, 200, 400].entries()) {
      fake.last()?.simulateClose();
      expect(conn.state).toBe("waiting");
      vi.advanceTimersByTime(delay - 1);
      expect(fake.sockets).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(fake.sockets).toHaveLength(i + 2);
    }

    // Success resets the attempt counter: next drop waits baseMs again.
    fake.last()?.simulateOpen();
    fake.last()?.simulateClose();
    vi.advanceTimersByTime(100);
    expect(fake.sockets).toHaveLength(5);
    conn.stop();
  });

  it("stops reconnecting after stop()", () => {
    const fake = fakeSocketFactory();
    const conn = startWorker({ config, logger: silentLogger, socketFactory: fake.factory });
    fake.last()?.simulateOpen();
    conn.stop();
    expect(fake.last()?.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(fake.sockets).toHaveLength(1);
    expect(conn.state).toBe("stopped");
  });

  it("sends keepalive pings while connected", () => {
    const fake = fakeSocketFactory();
    const conn = startWorker({ config, logger: silentLogger, socketFactory: fake.factory });
    const socket = fake.last();
    socket?.simulateOpen();
    vi.advanceTimersByTime(5000);
    expect(socket?.sent.at(-1)?.type).toBe("ping");
    conn.stop();
  });

  it("answers hub ping and runs a dispatched demo job end to end", async () => {
    const fake = fakeSocketFactory();
    const conn = startWorker({ config, logger: silentLogger, socketFactory: fake.factory });
    const socket = fake.last();
    if (!socket) throw new Error("no socket");
    socket.simulateOpen();

    socket.simulateMessage({ type: "ping", ts: 7 });
    const now = new Date().toISOString();
    const job: Job = {
      id: "job_9",
      type: "demo.echo",
      status: "running",
      payload: { text: "çay" },
      createdAt: now,
      updatedAt: now,
    };
    socket.simulateMessage({ type: "job.dispatch", job });
    await vi.waitFor(() => expect(socket.sent.at(-1)?.type).toBe("job.result"));

    expect(socket.sent.slice(1)).toEqual([
      { type: "pong", ts: 7 },
      { type: "job.progress", jobId: "job_9", progress: 0.5, message: "metin işleniyor" },
      {
        type: "job.result",
        jobId: "job_9",
        status: "succeeded",
        output: { text: "çay", reversed: "yaç", workerId: "mac-test" },
      },
    ]);
    conn.stop();
  });

  it("drops malformed frames without crashing", () => {
    const fake = fakeSocketFactory();
    const onMessage = vi.fn();
    const conn = new HubConnection({
      url: config.hubUrl,
      workerId: "w",
      capabilities: [],
      backoff: config.backoff,
      pingIntervalMs: 0,
      socketFactory: fake.factory,
      onMessage,
      logger: silentLogger,
    });
    conn.start();
    fake.last()?.simulateOpen();
    fake.last()?.simulateRaw("{garbage");
    fake.last()?.simulateRaw(JSON.stringify({ type: "nope" }));
    expect(onMessage).not.toHaveBeenCalled();
    expect(conn.state).toBe("connected");
    conn.stop();
  });

  it("ignores events from a superseded socket", () => {
    const fake = fakeSocketFactory();
    const conn = startWorker({ config, logger: silentLogger, socketFactory: fake.factory });
    const first = fake.last();
    first?.simulateClose();
    vi.advanceTimersByTime(100);
    expect(fake.sockets).toHaveLength(2);
    // A late close from the old socket must not schedule another reconnect.
    first?.simulateClose();
    vi.advanceTimersByTime(10_000);
    expect(fake.sockets).toHaveLength(2);
    conn.stop();
  });
});
