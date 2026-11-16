import { describe, expect, it } from "vitest";
import { describeHealth } from "../src/health-view.ts";

describe("describeHealth", () => {
  it("shows a loading state", () => {
    expect(describeHealth({ kind: "loading" }).tone).toBe("neutral");
  });

  it("shows a healthy API in Turkish", () => {
    const view = describeHealth({
      kind: "ok",
      data: {
        status: "ok",
        service: "studio-api",
        version: "0.0.0",
        time: "2026-11-16T10:00:00.000Z",
        checks: { db: "ok" },
      },
    });
    expect(view.title).toBe("API çalışıyor");
    expect(view.detail).toContain("veritabanı hazır");
    expect(view.tone).toBe("good");
  });

  it("shows errors", () => {
    const view = describeHealth({ kind: "error", message: "HTTP 502" });
    expect(view).toEqual({ title: "API'ye ulaşılamıyor", detail: "HTTP 502", tone: "bad" });
  });
});
