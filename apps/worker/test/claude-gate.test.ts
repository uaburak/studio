import { describe, expect, it } from "vitest";
import { ClaudeError, ClaudeUsageLimitError } from "../src/claude/errors.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import type { ClaudeCallOptions, ClaudeCallResult } from "../src/claude/runner.ts";

const ok = (label: string): ClaudeCallResult => ({
  output: { label },
  text: "",
  model: "claude-opus-5-5",
  cliVersion: "2.1.292",
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    durationMs: 1,
    durationApiMs: 1,
    wallMs: 1,
  },
  rateLimit: undefined,
});
const call = (label: string, signal?: AbortSignal): ClaudeCallOptions => ({
  label,
  system: "s",
  content: [],
  ...(signal ? { signal } : {}),
});

/** A fake clock whose sleep advances time instantly. */
function clock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      sleeps.push(ms);
      now += ms;
      await Promise.resolve();
    },
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ClaudeGate", () => {
  it("runs one call at a time by default, in FIFO order", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const gate = new ClaudeGate({
      runner: async (o) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(`start ${o.label}`);
        await new Promise((r) => setTimeout(r, 10));
        order.push(`end ${o.label}`);
        active--;
        return ok(o.label);
      },
    });
    const queued: number[] = [];
    await Promise.all(
      ["a", "b", "c"].map((l) => gate.call(call(l), { onQueued: (p) => queued.push(p) })),
    );
    expect(maxActive).toBe(1);
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(queued).toEqual([1, 2]);
    expect(gate.callCount).toBe(3);
  });

  it("allows more calls when configured", async () => {
    let active = 0;
    let maxActive = 0;
    const gate = new ClaudeGate({
      concurrency: 2,
      runner: async (o) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return ok(o.label);
      },
    });
    await Promise.all(["a", "b", "c", "d"].map((l) => gate.call(call(l))));
    expect(maxActive).toBe(2);
  });

  it("parks every call on a usage limit until the reset, then retries", async () => {
    const c = clock();
    const resetsAt = new Date(c.now() + 2 * 3_600_000);
    let calls = 0;
    const gate = new ClaudeGate({
      now: c.now,
      sleep: c.sleep,
      resetSlackMs: 60_000,
      maxSleepChunkMs: 600_000,
      runner: async (o) => {
        calls++;
        if (calls === 1) throw new ClaudeUsageLimitError("limit", resetsAt, "rate_limit_event");
        return ok(o.label);
      },
    });
    const events: string[] = [];
    const res = await gate.call(call("x"), {
      onPark: (info) => {
        events.push(`park ${info.until.toISOString()} ${info.source}`);
      },
      onResume: () => {
        events.push("resume");
      },
    });
    expect((res.output as { label: string }).label).toBe("x");
    expect(calls).toBe(2);
    expect(events).toEqual([`park ${resetsAt.toISOString()} rate_limit_event`, "resume"]);
    expect(c.now()).toBeGreaterThanOrEqual(resetsAt.getTime() + 60_000);
    expect(c.sleeps.every((ms) => ms <= 600_000)).toBe(true);
  });

  it("keeps later calls parked too and reports the park in status()", async () => {
    const c = clock();
    const gate = new ClaudeGate({ now: c.now, sleep: c.sleep, runner: async (o) => ok(o.label) });
    gate.park(new Date(c.now() + 600_000), "self-test");
    expect(gate.status().parkedUntil?.getTime()).toBe(c.now() + 600_000);
    let parked = false;
    await gate.call(call("later"), {
      onPark: () => {
        parked = true;
      },
    });
    expect(parked).toBe(true);
    expect(gate.status().parkedUntil).toBeNull();
  });

  it("can be cancelled while parked", async () => {
    const gate = new ClaudeGate({ runner: async (o) => ok(o.label) });
    gate.park(new Date(Date.now() + 3_600_000), "limit");
    const controller = new AbortController();
    const pending = gate.call(call("x", controller.signal), {
      onPark: () => controller.abort(new Error("cancelled by user")),
    });
    await expect(pending).rejects.toThrow("cancelled by user");
  });

  it("retries transient errors with backoff, then gives up", async () => {
    const c = clock();
    let calls = 0;
    const gate = new ClaudeGate({
      now: c.now,
      sleep: c.sleep,
      transientRetries: 2,
      transientDelayMs: 1000,
      runner: async () => {
        calls++;
        throw new ClaudeError("transient", "overloaded");
      },
    });
    await expect(gate.call(call("x"))).rejects.toThrow("overloaded");
    expect(calls).toBe(3);
    expect(c.sleeps).toEqual([1000, 2000]);
  });

  it("does not retry other errors and frees the slot", async () => {
    let calls = 0;
    const gate = new ClaudeGate({
      runner: async (o) => {
        calls++;
        if (o.label === "bad") throw new ClaudeError("output", "no structured output");
        return ok(o.label);
      },
    });
    await expect(gate.call(call("bad"))).rejects.toThrow("no structured output");
    await expect(gate.call(call("good"))).resolves.toMatchObject({ output: { label: "good" } });
    expect(calls).toBe(2);
    expect(gate.status().running).toBe(0);
  });
});
