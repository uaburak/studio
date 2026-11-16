import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProtocolMessage } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { ClaudeUsageLimitError } from "../src/claude/errors.ts";
import type { RateLimitInfo } from "../src/claude/limits.ts";
import { aliasOf, chooseModel, readChoice } from "../src/claude/models.ts";
import { UsageTracker, usageFromLimitError, usageFromRateLimit } from "../src/claude/usage.ts";
import { encodableUsageFrame, workerUsageFrame } from "../src/usage-report.ts";
import { REAL_STREAM } from "./fake-claude.ts";

const observed = new Date("2026-11-16T12:40:00Z");

function realRateLimit(): RateLimitInfo {
  const line = readFileSync(REAL_STREAM, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((e) => e.type === "rate_limit_event");
  return line.rate_limit_info;
}

describe("usage windows", () => {
  it("reads the five-hour and weekly windows from a real rate_limit_event", () => {
    const report = usageFromRateLimit(realRateLimit(), observed);
    expect(report).toEqual({
      source: "rate_limit_event",
      observedAt: observed.toISOString(),
      windows: [
        {
          kind: "five_hour",
          name: "five_hour",
          usedPercent: 71,
          resetsAt: new Date(1794845400 * 1000).toISOString(),
          limited: false,
        },
        {
          kind: "weekly",
          name: "seven_day",
          usedPercent: expect.any(Number),
          resetsAt: expect.any(String),
          limited: false,
        },
      ],
    });
  });

  it("marks the refusing window as limited", () => {
    const resetsAt = 1794845400;
    const report = usageFromRateLimit(
      {
        status: "rejected",
        rateLimitType: "five_hour",
        resetsAt,
        unifiedWindows: {
          five_hour: { utilization: 1, resetsAt },
          seven_day: { utilization: 0.6 },
        },
      },
      observed,
    );
    expect(report?.windows.map((w) => [w.kind, w.limited])).toEqual([
      ["five_hour", true],
      ["weekly", false],
    ]);
    const error = new ClaudeUsageLimitError(
      "limit",
      new Date(resetsAt * 1000),
      "message",
      undefined,
      undefined,
    );
    expect(usageFromLimitError(error, observed)).toEqual({
      source: "usage_limit_error",
      observedAt: observed.toISOString(),
      windows: [
        {
          kind: "other",
          name: "unknown",
          resetsAt: new Date(resetsAt * 1000).toISOString(),
          limited: true,
        },
      ],
    });
  });

  it("persists the latest report and reloads it as cached", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "usage-")), "claude-usage.json");
    const tracker = new UsageTracker(file);
    const seen: string[] = [];
    tracker.onUpdate((r) => seen.push(r.source));
    tracker.update(usageFromRateLimit(realRateLimit(), observed));
    expect(seen).toEqual(["rate_limit_event"]);
    await new Promise((r) => setTimeout(r, 50));
    const restarted = new UsageTracker(file);
    const loaded = await restarted.load();
    expect(loaded?.source).toBe("rate_limit_event (cached)");
    expect(loaded?.windows[0]?.usedPercent).toBe(71);
  });

  it("builds the worker.usage frame and sends it only when the contract knows it", () => {
    const report = usageFromRateLimit(realRateLimit(), observed);
    if (!report) throw new Error("no report");
    const frame = workerUsageFrame(report);
    expect(frame).toMatchObject({ type: "worker.usage", source: "rate_limit_event" });
    const supported = ProtocolMessage.options.some(
      (o) => (o.shape.type as { value?: string }).value === "worker.usage",
    );
    const encodable = encodableUsageFrame(report);
    if (supported) expect(encodable).not.toBeNull();
    else expect(encodable).toBeNull();
  });
});

describe("model and effort choice", () => {
  it("prefers the run, then the worker settings, then opus / medium", () => {
    expect(chooseModel(readChoice({ model: "haiku", effort: "low" }), { model: "opus" })).toEqual({
      model: "haiku",
      effort: "low",
      source: "run",
    });
    expect(
      chooseModel(readChoice({ model: "gpt", effort: 3 }), { model: "sonnet", effort: "xhigh" }),
    ).toEqual({
      model: "sonnet",
      effort: "xhigh",
      source: "settings",
    });
    expect(chooseModel(readChoice(null), {})).toEqual({
      model: "opus",
      effort: "medium",
      source: "default",
    });
    expect(aliasOf("claude-opus-5-5")).toBe("opus");
    expect(aliasOf("claude-sonnet-5")).toBe("sonnet");
    expect(aliasOf("fable")).toBeUndefined();
  });
});
