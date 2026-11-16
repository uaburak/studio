import { describe, expect, it } from "vitest";
import { backoffDelay } from "../src/backoff.ts";

describe("backoffDelay", () => {
  const base = { baseMs: 500, maxMs: 30_000 };

  it("grows exponentially without jitter", () => {
    expect([0, 1, 2, 3, 4].map((a) => backoffDelay(a, base))).toEqual([
      500, 1000, 2000, 4000, 8000,
    ]);
  });

  it("is capped at maxMs", () => {
    expect(backoffDelay(10, base)).toBe(30_000);
    expect(backoffDelay(1_000, base)).toBe(30_000);
  });

  it("supports a custom factor", () => {
    expect(backoffDelay(2, { ...base, factor: 3 })).toBe(4500);
  });

  it("applies jitter within [(1 - j) * d, d]", () => {
    const opts = { ...base, jitter: 0.2 };
    expect(backoffDelay(3, { ...opts, random: () => 0 })).toBe(3200);
    expect(backoffDelay(3, { ...opts, random: () => 0.999_999 })).toBe(4000);
    for (let i = 0; i < 100; i++) {
      const d = backoffDelay(3, opts);
      expect(d).toBeGreaterThanOrEqual(3200);
      expect(d).toBeLessThanOrEqual(4000);
    }
  });

  it("treats negative or fractional attempts sanely", () => {
    expect(backoffDelay(-5, base)).toBe(500);
    expect(backoffDelay(1.9, base)).toBe(1000);
  });
});
