import { ApiError, computeContentHash } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { fetchAllPages } from "../src/api.ts";
import { groupByDay } from "../src/features/calendar/CalendarPage.tsx";
import { defaultSlot } from "../src/features/calendar/ScheduleDialog.tsx";
import { jobsPollInterval } from "../src/features/jobs/JobsPage.tsx";
import { checkFile, guessMimeType } from "../src/features/media/upload.ts";
import { verifyVersionHash } from "../src/lib/approval.ts";
import { describeError } from "../src/lib/errors.ts";
import { formatBytes, initials } from "../src/lib/format.ts";
import { extractColorTokens, extractFontTokens, parseTokens } from "../src/lib/profile.ts";

describe("describeError", () => {
  it("maps contract error codes to Turkish titles and keeps the server detail", () => {
    const view = describeError(
      new ApiError("/api/contents/x/approve: hash does not match", 409, "hash_mismatch"),
    );
    expect(view.title).toMatch(/Sürüm değişti/);
    expect(view.detail).toBe("hash does not match");
    expect(view.conflict).toBe(true);
  });

  it("passes validation issues through", () => {
    const view = describeError(
      new ApiError("/api/brands: bad", 400, "validation_error", [
        { path: "name", message: "required" },
      ]),
    );
    expect(view.issues).toEqual([{ path: "name", message: "required" }]);
    expect(view.conflict).toBe(false);
  });

  it("treats fetch failures as connectivity problems", () => {
    expect(describeError(new TypeError("Failed to fetch")).title).toBe("API'ye ulaşılamıyor");
    expect(describeError(new ApiError("/api/health returned HTTP 502", 502)).title).toBe(
      "API'ye ulaşılamıyor",
    );
  });
});

describe("verifyVersionHash", () => {
  const slides = [{ html: "<html><body>1</body></html>", width: 1080, height: 1350 }];

  it("verifies a matching hash", async () => {
    const hash = await computeContentHash(slides);
    expect(
      await verifyVersionHash({
        slides: slides.map((s) => ({ ...s, renderedAssetId: null })),
        contentHash: hash,
      }),
    ).toEqual({
      kind: "verified",
      hash,
    });
  });

  it("detects a mismatch", async () => {
    const result = await verifyVersionHash({
      slides: slides.map((s) => ({ ...s, renderedAssetId: null })),
      contentHash: "f".repeat(64),
    });
    expect(result.kind).toBe("mismatch");
  });

  it("falls back to the server hash without WebCrypto", async () => {
    const result = await verifyVersionHash({ slides: [], contentHash: "e".repeat(64) }, null);
    expect(result).toEqual({ kind: "unverifiable", hash: "e".repeat(64) });
  });
});

describe("profile tokens", () => {
  const tokens = {
    colors: { primary: "#0a7d3b", text: "rgb(10, 10, 10)", bad: "green" },
    palette: ["#fff", "oklch(0.7 0.1 30)"],
    fonts: { heading: "Söhne", body: "Inter" },
    radius: 12,
  };

  it("finds colour leaves with their paths", () => {
    expect(extractColorTokens(tokens)).toEqual([
      { path: "colors.primary", value: "#0a7d3b" },
      { path: "colors.text", value: "rgb(10, 10, 10)" },
      { path: "palette.0", value: "#fff" },
      { path: "palette.1", value: "oklch(0.7 0.1 30)" },
    ]);
  });

  it("finds font names", () => {
    expect(extractFontTokens(tokens).map((t) => t.value)).toEqual(["Söhne", "Inter"]);
  });

  it("parses the tokens editor", () => {
    expect(parseTokens("")).toEqual({ ok: true, value: {} });
    expect(parseTokens('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseTokens("[1]").ok).toBe(false);
    expect(parseTokens("{oops").ok).toBe(false);
  });
});

describe("upload checks", () => {
  it("guesses font mime types from the extension", () => {
    expect(guessMimeType({ name: "Brand.woff2", type: "" })).toBe("font/woff2");
    expect(guessMimeType({ name: "x.TTF", type: "application/octet-stream" })).toBe("font/ttf");
    expect(guessMimeType({ name: "a.wav", type: "audio/x-wav" })).toBe("audio/wav");
  });

  it("enforces the API allow-list and size limits", () => {
    expect(checkFile({ name: "a.png", type: "image/png", size: 1000 })).toMatchObject({
      ok: true,
      kind: "image",
    });
    expect(checkFile({ name: "logo.svg", type: "image/svg+xml", size: 1000 })).toMatchObject({
      ok: true,
      kind: "logo",
    });
    expect(checkFile({ name: "a.exe", type: "application/x-msdownload", size: 10 })).toEqual({
      ok: false,
      error: "Desteklenmeyen dosya türü",
    });
    const big = checkFile({ name: "a.svg", type: "image/svg+xml", size: 3 * 1024 * 1024 });
    expect(big.ok).toBe(false);
    expect(checkFile({ name: "a.png", type: "image/png", size: 0 }).ok).toBe(false);
  });
});

describe("small helpers", () => {
  it("formats bytes the Turkish way", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1,5 KB");
    expect(formatBytes(20 * 1024 * 1024)).toBe("20 MB");
  });

  it("makes initials with Turkish casing", () => {
    expect(initials("MTM Agro")).toBe("MA");
    expect(initials("istanbul")).toBe("İS");
  });

  it("follows cursors until the last page", async () => {
    const pages: Record<string, { items: number[]; nextCursor: string | null }> = {
      "": { items: [1, 2], nextCursor: "a" },
      a: { items: [3], nextCursor: null },
    };
    expect(
      await fetchAllPages(async (c) => pages[c ?? ""] ?? { items: [], nextCursor: null }),
    ).toEqual([1, 2, 3]);
  });

  it("polls jobs faster while they move", () => {
    expect(jobsPollInterval([{ status: "running" }])).toBe(2000);
    expect(jobsPollInterval([{ status: "queued" }])).toBe(5000);
    expect(jobsPollInterval([{ status: "succeeded" }])).toBe(15000);
  });

  it("groups schedules by local day", () => {
    const base = {
      contentId: "c",
      brandId: "b",
      platform: "instagram" as const,
      socialAccountId: "a",
      versionId: "v",
      contentHash: "a".repeat(64),
      status: "pending" as const,
      cancelledAt: null,
      createdAt: "2026-11-16T00:00:00.000Z",
      updatedAt: "2026-11-16T00:00:00.000Z",
    };
    const map = groupByDay(
      [
        { ...base, id: "1", scheduledAt: "2026-11-16T22:30:00.000Z" }, // 17 Nov 01:30 in Istanbul
        { ...base, id: "2", scheduledAt: "2026-11-16T20:00:00.000Z" }, // 16 Nov 23:00
      ],
      "Europe/Istanbul",
    );
    expect(map.get("2026-11-17")?.map((s) => s.id)).toEqual(["1"]);
    expect(map.get("2026-11-16")?.map((s) => s.id)).toEqual(["2"]);
  });

  it("defaults new schedules to tomorrow 10:00 local", () => {
    expect(defaultSlot(new Date("2026-11-16T22:30:00Z"), "Europe/Istanbul")).toEqual({
      year: 2026,
      month: 11,
      day: 18,
      hour: 10,
      minute: 0,
    });
  });
});
