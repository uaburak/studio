import { describe, expect, it } from "vitest";
import {
  BrandKit,
  BrandKitPut,
  brandKitAnalysisBlocker,
  createApiClient,
  emptyBrandKit,
  MAX_KIT_SAMPLES,
} from "../src/index.ts";

describe("brand kit", () => {
  it("fills defaults and keeps logo backgrounds, font licences and palette", () => {
    const parsed = BrandKitPut.parse({
      logos: [{ assetId: "a1" }, { assetId: "a2", background: "dark", label: "Beyaz logo" }],
      fonts: [{ assetId: "f1", family: "Archivo", role: "display", licenseNote: "OFL" }],
      palette: [{ name: "accent", hex: "#ff6a00", use: "ana vurgu" }],
      samples: [{ assetId: "s1" }, { assetId: "s2", caption: "Hasat başladı" }],
    });
    expect(parsed.logos[0]?.background).toBe("any");
    expect(parsed.logos[1]?.background).toBe("dark");
    expect(parsed.fonts[0]?.licenseNote).toBe("OFL");
    expect(parsed.notes).toBe("");
    expect(BrandKitPut.parse({})).toEqual({
      logos: [],
      fonts: [],
      palette: [],
      samples: [],
      notes: "",
    });
  });

  it("rejects bad colours, names, duplicates and too many samples", () => {
    expect(BrandKitPut.safeParse({ palette: [{ name: "accent", hex: "orange" }] }).success).toBe(
      false,
    );
    expect(BrandKitPut.safeParse({ palette: [{ name: "Ana Renk", hex: "#FF6A00" }] }).success).toBe(
      false,
    );
    expect(
      BrandKitPut.safeParse({
        palette: [
          { name: "accent", hex: "#FF6A00" },
          { name: "accent", hex: "#000000" },
        ],
      }).success,
    ).toBe(false);
    expect(BrandKitPut.safeParse({ samples: [{ assetId: "s" }, { assetId: "s" }] }).success).toBe(
      false,
    );
    const many = Array.from({ length: MAX_KIT_SAMPLES + 1 }, (_, i) => ({ assetId: `s${i}` }));
    expect(BrandKitPut.safeParse({ samples: many }).success).toBe(false);
    expect(BrandKitPut.safeParse({ fonts: [{ assetId: "f", family: "<script>" }] }).success).toBe(
      false,
    );
  });

  it("explains when analysis cannot run", () => {
    expect(brandKitAnalysisBlocker({ samples: [] })).toContain("en az 3");
    expect(brandKitAnalysisBlocker({ samples: [{ assetId: "a" }, { assetId: "b" }] })).toContain(
      "şu an 2",
    );
    expect(
      brandKitAnalysisBlocker({ samples: [{ assetId: "a" }, { assetId: "b" }, { assetId: "c" }] }),
    ).toBeNull();
  });

  it("client reads and writes the kit", async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const stored = { ...emptyBrandKit("b1"), notes: "not", updatedAt: "2026-11-16T10:00:00.000Z" };
    const client = createApiClient({
      baseUrl: "http://x",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response(JSON.stringify(stored), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    expect(BrandKit.parse(await client.brandKits.get("b1"))).toEqual(stored);
    await client.brandKits.put("b1", { notes: "not" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET http://x/api/brands/b1/kit",
      "PUT http://x/api/brands/b1/kit",
    ]);
    expect(calls[1]?.body).toEqual({ notes: "not" });
  });
});
