import type { Job, WorkerToHubMessage } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { createMessageHandler } from "../src/handler.ts";
import { demoEcho } from "../src/jobs/demo-echo.ts";

const now = "2026-11-16T10:00:00.000Z";
const job = (payload: Record<string, unknown>): Job => ({
  id: "job_1",
  type: "demo.echo",
  status: "running",
  payload,
  createdAt: now,
  updatedAt: now,
});

function setup(handlers = { "demo.echo": demoEcho }) {
  const sent: WorkerToHubMessage[] = [];
  const handle = createMessageHandler({
    workerId: "mac-test",
    handlers,
    send: (m) => sent.push(m),
  });
  return { sent, handle };
}

describe("message handler", () => {
  it("answers ping with pong carrying the same ts", async () => {
    const { sent, handle } = setup();
    await handle({ type: "ping", ts: 123 });
    expect(sent).toEqual([{ type: "pong", ts: 123 }]);
  });

  it("runs demo.echo: dispatch -> progress -> result", async () => {
    const { sent, handle } = setup();
    await handle({ type: "job.dispatch", job: job({ text: "abc" }) });
    expect(sent).toEqual([
      { type: "job.progress", jobId: "job_1", progress: 0.5, message: "metin işleniyor" },
      {
        type: "job.result",
        jobId: "job_1",
        status: "succeeded",
        output: { text: "abc", reversed: "cba", workerId: "mac-test" },
      },
    ]);
  });

  it("reports failure when the payload is invalid", async () => {
    const { sent, handle } = setup();
    await handle({ type: "job.dispatch", job: job({ nope: true }) });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "job.result", jobId: "job_1", status: "failed" });
  });

  it("reports failure for job types it cannot handle", async () => {
    const { sent, handle } = setup({} as { "demo.echo": typeof demoEcho });
    await handle({ type: "job.dispatch", job: job({ text: "x" }) });
    expect(sent).toEqual([
      {
        type: "job.result",
        jobId: "job_1",
        status: "failed",
        error: "unsupported job type: demo.echo",
      },
    ]);
  });

  it("ignores pong", async () => {
    const { sent, handle } = setup();
    await handle({ type: "pong", ts: 1 });
    expect(sent).toEqual([]);
  });
});
