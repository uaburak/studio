import { env, exports } from "cloudflare:workers";
import {
  type ApiErrorBody,
  type Device,
  type DeviceList,
  HealthResponse,
  type MacRoutes,
  PAIRING_MAX_FAILURES_PER_CLIENT,
  PAIRING_SECRET_TTL_MS,
  type PairingCode,
  type PairingResult,
} from "@studio/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { BASE } from "./helpers.ts";

/*
 * Access control and device pairing (task L1). Requests are built by hand so
 * every header is explicit:
 *  - LOCAL: what Miniflare sets for a request from this Mac (127.0.0.1),
 *  - LAN: what the LAN gateway sets for a phone (peer address + marker).
 */

const LOCAL = { "CF-Connecting-IP": "127.0.0.1" };
let lanCounter = 0;
/** A distinct LAN client per call site, so rate limits do not leak between tests. */
const lan = (ip = `10.0.${Math.floor(lanCounter / 250)}.${(lanCounter++ % 250) + 1}`) => ({
  "CF-Connecting-IP": ip,
  "X-Studio-Gateway": "1",
});
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function call<T = unknown>(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown,
) {
  const res = await exports.default.fetch(`${BASE}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
  return { status: res.status, body: parsed as T, headers: res.headers };
}

async function newOffer(): Promise<PairingCode> {
  const res = await call<PairingCode>("POST", "/api/pairing/codes", LOCAL);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.code).toMatch(/^\d{6}$/);
  return res.body;
}

async function newCode(): Promise<string> {
  return (await newOffer()).code;
}

async function pair(name = "Burak'ın iPhone'u", client = lan()): Promise<PairingResult> {
  const code = await newCode();
  const res = await call<PairingResult>("POST", "/api/pairing/claim", client, {
    code,
    deviceName: name,
    platform: "ios",
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

beforeEach(async () => {
  // Tests share one D1; start each with an empty failure log.
  await env.DB.prepare("delete from pairing_failures").run();
});

describe("access control matrix", () => {
  it("lets the Mac itself in without a token", async () => {
    expect((await call("GET", "/api/brands", LOCAL)).status).toBe(200);
    expect((await call("GET", "/api/brands", { "CF-Connecting-IP": "::1" })).status).toBe(200);
  });

  it("rejects a LAN request without a token, with the contract error and a Bearer challenge", async () => {
    const res = await call<ApiErrorBody>("GET", "/api/brands", lan());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
  });

  it("does not trust a spoofed 127.0.0.1 that came through the gateway", async () => {
    expect((await call("GET", "/api/brands", lan("127.0.0.1"))).status).toBe(401);
  });

  it("fails closed when the client address is unknown", async () => {
    expect((await call("GET", "/api/brands", {})).status).toBe(401);
  });

  it("accepts the worker token from the LAN", async () => {
    const res = await call("GET", "/api/brands", { ...lan(), ...bearer("test-worker-token") });
    expect(res.status).toBe(200);
    expect((await call("GET", "/api/brands", { ...lan(), ...bearer("wrong-token") })).status).toBe(
      401,
    );
  });

  it("accepts a paired device token and refuses it after revocation", async () => {
    const { device, token } = await pair();
    const phone = { ...lan(), ...bearer(token) };
    expect((await call("GET", "/api/brands", phone)).status).toBe(200);

    const revoked = await call<Device>("POST", `/api/devices/${device.id}/revoke`, LOCAL);
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedAt).not.toBeNull();
    const after = await call<ApiErrorBody>("GET", "/api/brands", phone);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("unauthorized");
  });

  it("keeps health and the claim endpoint public", async () => {
    const health = await call("GET", "/api/health", lan());
    expect(health.status).toBe(200);
    HealthResponse.parse(health.body);
    const claim = await call("POST", "/api/pairing/claim", lan(), { code: "x" });
    expect(claim.status).toBe(400); // validation, not 401
  });

  it("guards WebSocket upgrades too", async () => {
    const res = await call("GET", "/api/jobs/stream", { ...lan(), Upgrade: "websocket" });
    expect(res.status).toBe(401);
  });

  it("lets only the Mac manage devices", async () => {
    const { token } = await pair();
    const phone = { ...lan(), ...bearer(token) };
    for (const [method, path] of [
      ["POST", "/api/pairing/codes"],
      ["GET", "/api/devices"],
      ["POST", "/api/devices/whatever/revoke"],
    ] as const) {
      const res = await call<ApiErrorBody>(method, path, phone);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
    }
    const worker = await call("GET", "/api/devices", { ...lan(), ...bearer("test-worker-token") });
    expect(worker.status).toBe(403);
  });
});

describe("pairing", () => {
  it("issues a working token, stores only its hash and lists the device", async () => {
    const { device, token } = await pair("Test telefon");
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(device).toMatchObject({ name: "Test telefon", platform: "ios", revokedAt: null });

    const stored = await env.DB.prepare("select token_hash from devices where id = ?")
      .bind(device.id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.token_hash).not.toContain(token);

    const list = await call<DeviceList>("GET", "/api/devices", LOCAL);
    expect(list.body.items.map((d) => d.id)).toContain(device.id);

    await call("GET", "/api/brands", { ...lan(), ...bearer(token) });
    const seen = await call<DeviceList>("GET", "/api/devices", LOCAL);
    expect(seen.body.items.find((d) => d.id === device.id)?.lastSeenAt).not.toBeNull();
  });

  it("rejects a reused code", async () => {
    const code = await newCode();
    const body = { code, deviceName: "A", platform: "ios" };
    expect((await call("POST", "/api/pairing/claim", lan(), body)).status).toBe(201);
    const again = await call<ApiErrorBody>("POST", "/api/pairing/claim", lan(), body);
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe("unauthorized");
  });

  it("rejects an expired code", async () => {
    const code = await newCode();
    await env.DB.prepare("update pairing_codes set expires_at = ? where used_at is null")
      .bind(Date.now() - 1000)
      .run();
    const res = await call<ApiErrorBody>("POST", "/api/pairing/claim", lan(), {
      code,
      deviceName: "A",
    });
    expect(res.status).toBe(401);
  });

  it("invalidates the previous code when a new one is created", async () => {
    const first = await newCode();
    const second = await newCode();
    const client = lan();
    if (first !== second) {
      expect(
        (await call("POST", "/api/pairing/claim", client, { code: first, deviceName: "A" })).status,
      ).toBe(401);
    }
    expect(
      (await call("POST", "/api/pairing/claim", client, { code: second, deviceName: "A" })).status,
    ).toBe(201);
  });

  it("rate-limits failed attempts per client, even for the right code", async () => {
    const code = await newCode();
    const wrong = code === "000000" ? "000001" : "000000";
    const attacker = lan("10.9.9.9");
    for (let i = 0; i < PAIRING_MAX_FAILURES_PER_CLIENT; i++) {
      const res = await call("POST", "/api/pairing/claim", attacker, {
        code: wrong,
        deviceName: "x",
      });
      expect(res.status).toBe(401);
    }
    const limited = await call<ApiErrorBody>("POST", "/api/pairing/claim", attacker, {
      code,
      deviceName: "x",
    });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);

    // Another client is not blocked by this one (below the global cap).
    expect(
      (await call("POST", "/api/pairing/claim", lan("10.9.9.10"), { code, deviceName: "ok" }))
        .status,
    ).toBe(201);
  });

  it("caps failed attempts across all clients", async () => {
    const code = await newCode();
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 20; i++) {
      await call("POST", "/api/pairing/claim", lan(`10.8.0.${i + 1}`), {
        code: wrong,
        deviceName: "x",
      });
    }
    const res = await call("POST", "/api/pairing/claim", lan("10.8.1.1"), {
      code,
      deviceName: "x",
    });
    expect(res.status).toBe(429);
  });
});

describe("QR pairing", () => {
  it("issues a long secret next to the code, valid for ten minutes", async () => {
    const before = Date.now();
    const offer = await newOffer();
    expect(offer.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const lifetime = new Date(offer.secretExpiresAt ?? 0).getTime() - before;
    expect(lifetime).toBeGreaterThan(PAIRING_SECRET_TTL_MS - 5_000);
    expect(lifetime).toBeLessThanOrEqual(PAIRING_SECRET_TTL_MS + 1_000);
    const stored = await env.DB.prepare(
      "select secret_hash from pairing_codes where used_at is null order by created_at desc limit 1",
    ).first<{ secret_hash: string }>();
    expect(stored?.secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.secret_hash).not.toBe(offer.secret);
  });

  it("pairs with the QR secret once; the code of the same offer is used up too", async () => {
    const offer = await newOffer();
    const res = await call<PairingResult>("POST", "/api/pairing/claim", lan(), {
      secret: offer.secret,
      deviceName: "QR iPhone",
      platform: "ios",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await call("GET", "/api/brands", { ...lan(), ...bearer(res.body.token) })).status).toBe(
      200,
    );

    const again = await call<ApiErrorBody>("POST", "/api/pairing/claim", lan(), {
      secret: offer.secret,
      deviceName: "QR iPhone",
    });
    expect(again.status).toBe(401);
    expect(again.body.error.code).toBe("unauthorized");
    const byCode = await call("POST", "/api/pairing/claim", lan(), {
      code: offer.code,
      deviceName: "QR iPhone",
    });
    expect(byCode.status).toBe(401);
  });

  it("rejects an expired secret even while the offer is otherwise unused", async () => {
    const offer = await newOffer();
    await env.DB.prepare("update pairing_codes set secret_expires_at = ? where used_at is null")
      .bind(Date.now() - 1000)
      .run();
    const res = await call<ApiErrorBody>("POST", "/api/pairing/claim", lan(), {
      secret: offer.secret,
      deviceName: "A",
    });
    expect(res.status).toBe(401);
  });

  it("keeps the secret valid after the 2-minute code ran out", async () => {
    const offer = await newOffer();
    await env.DB.prepare("update pairing_codes set expires_at = ? where used_at is null")
      .bind(Date.now() - 1000)
      .run();
    const res = await call("POST", "/api/pairing/claim", lan(), {
      secret: offer.secret,
      deviceName: "A",
    });
    expect(res.status).toBe(201);
  });

  it("refuses a claim with both or neither of code and secret", async () => {
    const offer = await newOffer();
    for (const body of [
      { code: offer.code, secret: offer.secret, deviceName: "A" },
      { deviceName: "A" },
    ]) {
      expect((await call("POST", "/api/pairing/claim", lan(), body)).status).toBe(400);
    }
  });

  it("retires the phone's previous device when it pairs again", async () => {
    const first = await pair("Aynı iPhone");
    const offer = await newOffer();
    const second = await call<PairingResult>("POST", "/api/pairing/claim", lan(), {
      secret: offer.secret,
      deviceName: "Aynı iPhone",
      replacesToken: first.token,
    });
    expect(second.status).toBe(201);
    const list = await call<DeviceList>("GET", "/api/devices", LOCAL);
    expect(list.body.items.find((d) => d.id === first.device.id)?.revokedAt).not.toBeNull();
    expect(list.body.items.find((d) => d.id === second.body.device.id)?.revokedAt).toBeNull();
    expect((await call("GET", "/api/brands", { ...lan(), ...bearer(first.token) })).status).toBe(
      401,
    );
  });
});

describe("routes", () => {
  const input = {
    macName: "Burak's MacBook Pro",
    macId: "mac-1",
    lanAddresses: ["192.168.1.20", "10.0.0.5"],
    lanPort: 8791,
    bonjourName: "Burak's MacBook Pro",
    tunnelUrl: "https://social.example.net",
  };

  it("lets only the Mac publish them; paired phones read them and get them when pairing", async () => {
    const { token } = await pair();
    const phone = { ...lan(), ...bearer(token) };
    expect((await call("PUT", "/api/pairing/routes", phone, input)).status).toBe(403);

    const saved = await call<MacRoutes>("PUT", "/api/pairing/routes", LOCAL, input);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject(input);
    expect(Date.parse(saved.body.updatedAt)).not.toBeNaN();

    const read = await call<MacRoutes>("GET", "/api/pairing/routes", phone);
    expect(read.status).toBe(200);
    expect(read.body).toEqual(saved.body);
    expect((await call("GET", "/api/pairing/routes", lan())).status).toBe(401);

    const offer = await newOffer();
    const paired = await call<PairingResult>("POST", "/api/pairing/claim", lan(), {
      secret: offer.secret,
      deviceName: "B",
    });
    expect(paired.body.routes).toEqual(saved.body);
  });

  it("validates addresses and the tunnel scheme", async () => {
    for (const bad of [
      { ...input, lanAddresses: ["not-an-ip"] },
      { ...input, tunnelUrl: "http://plain.example.net" },
      { ...input, lanPort: 0 },
    ]) {
      expect((await call("PUT", "/api/pairing/routes", LOCAL, bad)).status).toBe(400);
    }
  });
});

describe("health", () => {
  it("omits the instance id when none is configured", async () => {
    const res = await call<HealthResponse>("GET", "/api/health", LOCAL);
    expect(res.body.instance).toBeUndefined();
  });
});
