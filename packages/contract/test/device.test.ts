import { describe, expect, it } from "vitest";
import {
  createApiClient,
  ERROR_STATUS,
  HealthResponse,
  MacRoutes,
  MacRoutesInput,
  PairingClaim,
  PairingCode,
  PairingResult,
} from "../src/index.ts";

describe("device pairing schemas", () => {
  it("accepts exactly six digits as a code", () => {
    expect(
      PairingCode.safeParse({ code: "012345", expiresAt: "2026-11-16T10:00:00.000Z" }).success,
    ).toBe(true);
    for (const code of ["12345", "1234567", "12a456", " 123456"]) {
      expect(PairingClaim.safeParse({ code, deviceName: "iPhone" }).success).toBe(false);
    }
  });

  it("defaults the platform and trims the device name", () => {
    const parsed = PairingClaim.parse({ code: "000001", deviceName: "  Deniz'in iPhone'u " });
    expect(parsed).toEqual({ code: "000001", deviceName: "Deniz'in iPhone'u", platform: "other" });
    expect(PairingClaim.safeParse({ code: "000001", deviceName: "   " }).success).toBe(false);
  });

  it("claims with exactly one of a code and a QR secret", () => {
    const secret = "A".repeat(43);
    expect(PairingClaim.safeParse({ secret, deviceName: "iPhone" }).success).toBe(true);
    expect(PairingClaim.safeParse({ code: "000001", secret, deviceName: "iPhone" }).success).toBe(
      false,
    );
    expect(PairingClaim.safeParse({ deviceName: "iPhone" }).success).toBe(false);
    expect(PairingClaim.safeParse({ secret: "short", deviceName: "iPhone" }).success).toBe(false);
    expect(PairingClaim.safeParse({ secret: "a/b+c=".repeat(8), deviceName: "x" }).success).toBe(
      false,
    );
    expect(
      PairingCode.parse({
        code: "123456",
        expiresAt: "2026-11-16T10:02:00.000Z",
        secret,
        secretExpiresAt: "2026-11-16T10:10:00.000Z",
      }).secret,
    ).toBe(secret);
  });

  it("describes the Mac's routes", () => {
    const routes = {
      macName: "Deniz's MacBook Pro",
      macId: null,
      lanAddresses: ["192.168.1.20"],
      lanPort: 8791,
      bonjourName: "Deniz's MacBook Pro",
      tunnelUrl: "https://social.example.net",
      updatedAt: "2026-11-16T10:00:00.000Z",
    };
    expect(MacRoutes.parse(routes)).toEqual(routes);
    expect(MacRoutes.safeParse({ ...routes, lanAddresses: ["fe80::1"] }).success).toBe(false);
    expect(MacRoutes.safeParse({ ...routes, tunnelUrl: "http://x.example" }).success).toBe(false);
    const { updatedAt: _ignored, ...input } = routes;
    expect(MacRoutesInput.safeParse(input).success).toBe(true);
  });

  it("requires a long token in the claim result", () => {
    const device = {
      id: "d1",
      name: "iPhone",
      platform: "ios",
      createdAt: "2026-11-16T10:00:00.000Z",
      lastSeenAt: null,
      revokedAt: null,
    };
    expect(PairingResult.safeParse({ device, token: "short" }).success).toBe(false);
    expect(PairingResult.safeParse({ device, token: "x".repeat(40) }).success).toBe(true);
  });

  it("maps the new auth error codes", () => {
    expect(ERROR_STATUS.unauthorized).toBe(401);
    expect(ERROR_STATUS.forbidden).toBe(403);
    expect(ERROR_STATUS.rate_limited).toBe(429);
  });

  it("keeps health backwards compatible (instance is optional)", () => {
    const base = {
      status: "ok",
      service: "studio-api",
      version: "0.0.0",
      time: "2026-11-16T10:00:00.000Z",
      checks: { db: "ok" },
    };
    expect(HealthResponse.safeParse(base).success).toBe(true);
    expect(HealthResponse.parse({ ...base, instance: "abc" }).instance).toBe("abc");
  });

  it("client calls the pairing and device routes", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    const device = {
      id: "d1",
      name: "iPhone",
      platform: "ios",
      createdAt: "2026-11-16T10:00:00.000Z",
      lastSeenAt: null,
      revokedAt: null,
    };
    const api = createApiClient({
      baseUrl: "http://mac.local:8791",
      fetch: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: (init?.body as string) ?? null,
        });
        const path = new URL(String(input)).pathname;
        const body =
          path === "/api/pairing/claim"
            ? { device, token: "t".repeat(43) }
            : path === "/api/devices"
              ? { items: [device] }
              : path === "/api/pairing/codes"
                ? { code: "123456", expiresAt: "2026-11-16T10:02:00.000Z" }
                : { ...device, revokedAt: "2026-11-16T10:05:00.000Z" };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect((await api.pairing.createCode()).code).toBe("123456");
    expect(
      (await api.pairing.claim({ code: "123456", deviceName: "iPhone", platform: "ios" })).token,
    ).toHaveLength(43);
    expect((await api.devices.list()).items).toHaveLength(1);
    expect((await api.devices.revoke("d1")).revokedAt).not.toBeNull();
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/pairing/codes",
      "POST /api/pairing/claim",
      "GET /api/devices",
      "POST /api/devices/d1/revoke",
    ]);
  });
});
