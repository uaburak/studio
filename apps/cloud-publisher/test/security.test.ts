import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import type { CloudOrder } from "@studio/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptToken,
  encryptToken,
  importTokenKey,
  signMediaPath,
  verifyMediaSignature,
} from "../src/crypto.ts";
import type { Scheduler } from "../src/scheduler.ts";
import {
  api,
  BASE,
  createReadyOrder,
  expectError,
  fakeJpeg,
  HOUR,
  PAGE_TOKEN,
  PUBLISHER_TOKEN,
  runUntilIdle,
  scheduler,
  setup,
  T0,
  target,
  USER_TOKEN,
} from "./helpers.ts";

const img = (n: number) => ({ id: `slide-${n}.jpg`, bytes: fakeJpeg(n) });
const SECRET = "test-media-url-secret";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bearer auth", () => {
  it("rejects missing, malformed and wrong tokens on every /v1 route", async () => {
    await setup();
    const routes: [string, string][] = [
      ["GET", "/v1/orders"],
      ["GET", "/v1/orders/x"],
      ["GET", "/v1/orders/x/log"],
      ["PUT", "/v1/orders/x"],
      ["PUT", "/v1/orders/x/media/a.jpg"],
      ["POST", "/v1/orders/x/cancel"],
    ];
    const headers: Record<string, string>[] = [
      {},
      { authorization: PUBLISHER_TOKEN },
      { authorization: "Bearer wrong-token" },
      { authorization: `Bearer ${PUBLISHER_TOKEN}x` },
      { authorization: `Basic ${btoa(`u:${PUBLISHER_TOKEN}`)}` },
    ];
    for (const [method, path] of routes) {
      for (const h of headers) {
        const res = await api(method, path, method === "PUT" ? {} : undefined, h);
        expectError(res, 401, "unauthorized");
      }
    }
    expect((await api("GET", "/v1/orders")).status).toBe(200);
    expect((await api("GET", "/health", undefined, {})).status).toBe(200);
  });
});

describe("token encryption", () => {
  it("round-trips and is bound to its key and row", async () => {
    const key = await importTokenKey(env.TOKEN_ENCRYPTION_KEY);
    const sealed = await encryptToken(key, USER_TOKEN, "row-a");
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain(USER_TOKEN);
    expect(sealed).not.toContain("EAA");
    expect(await decryptToken(key, sealed, "row-a")).toBe(USER_TOKEN);
    // Fresh IV each time.
    expect(await encryptToken(key, USER_TOKEN, "row-a")).not.toBe(sealed);
    await expect(decryptToken(key, sealed, "row-b")).rejects.toThrow();
    const otherKey = await importTokenKey(btoa("x".repeat(32)));
    await expect(decryptToken(otherKey, sealed, "row-a")).rejects.toThrow();
    await expect(importTokenKey(btoa("short"))).rejects.toThrow(/32 bytes/);
    await expect(importTokenKey(undefined)).rejects.toThrow();
  });

  it("stores only ciphertext and never returns or logs tokens", async () => {
    const lines: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    const h = await setup();
    const created = await createReadyOrder(
      "sec-1",
      [img(1)],
      [target("instagram.image"), target("facebook.photo")],
    );
    const bodies: string[] = [JSON.stringify(created)];

    const stored = await runInDurableObject(scheduler(), (_i: Scheduler, state) =>
      state.storage.sql.exec<{ token: string }>("SELECT token FROM targets").toArray(),
    );
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.token).toMatch(/^v1\./);
      expect(row.token).not.toContain("EAA");
    }

    h.clock.t = T0 + HOUR;
    await runUntilIdle(h);
    for (const path of ["/v1/orders/sec-1", "/v1/orders/sec-1/log", "/v1/orders"]) {
      bodies.push((await api("GET", path)).text);
    }
    const order = JSON.parse(bodies[1] ?? "{}") as CloudOrder;
    expect(order.status).toBe("published");
    // The fake Graph API saw the real tokens (decryption worked)...
    const authHeaders = h.fake.calls.map((c) => c.headers.authorization ?? "");
    expect(authHeaders.some((a) => a.includes(USER_TOKEN))).toBe(true);
    expect(authHeaders.some((a) => a.includes(PAGE_TOKEN))).toBe(true);
    // ...but no response or log line ever contained one.
    expect(lines.length).toBeGreaterThan(0);
    for (const text of [...bodies, ...lines]) {
      expect(text).not.toContain(USER_TOKEN);
      expect(text).not.toContain(PAGE_TOKEN);
      expect(text).not.toContain("accessToken");
    }
    // Tokens are dropped once a target is finished.
    const after = await runInDurableObject(scheduler(), (_i: Scheduler, state) =>
      state.storage.sql.exec<{ token: string | null }>("SELECT token FROM targets").toArray(),
    );
    expect(after.every((r) => r.token === null)).toBe(true);
  });
});

describe("signed media URLs", () => {
  const future = () => Math.floor(Date.now() / 1000) + 3600;

  it("serves uploaded media to a valid signature only", async () => {
    await setup();
    await createReadyOrder("m-1", [img(1)], [target("instagram.image")]);
    const path = await signMediaPath(SECRET, "m-1", "slide-1.jpg", future());

    const ok = await exports.default.fetch(`${BASE}${path}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(img(1).bytes);

    const head = await exports.default.fetch(`${BASE}${path}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(img(1).bytes.byteLength));

    const ranged = await exports.default.fetch(`${BASE}${path}`, {
      headers: { range: "bytes=0-9" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe(`bytes 0-9/${img(1).bytes.byteLength}`);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(img(1).bytes.slice(0, 10));

    // No bearer token needed (Meta fetches it), but every part is signed.
    const segments = path.split("/"); // ["", "media", order, exp, sig, media]
    const tamper = (i: number, value: string) => {
      const copy = [...segments];
      copy[i] = value;
      return `${BASE}${copy.join("/")}`;
    };
    const sig = segments[4] ?? "";
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    for (const url of [
      tamper(2, "m-2"),
      tamper(3, String(future() + 10)),
      tamper(4, flipped),
      tamper(4, "short"),
      tamper(5, "slide-2.jpg"),
    ]) {
      expect((await exports.default.fetch(url)).status, url).toBe(403);
    }
    const unsigned = await exports.default.fetch(`${BASE}/media/m-1/slide-1.jpg`);
    expect(unsigned.status).toBe(404);
  });

  it("rejects expired signatures", async () => {
    await setup();
    await createReadyOrder("m-2", [img(1)], [target("instagram.image")]);
    const exp = Math.floor(Date.now() / 1000) - 1;
    const path = await signMediaPath(SECRET, "m-2", "slide-1.jpg", exp);
    expect((await exports.default.fetch(`${BASE}${path}`)).status).toBe(410);
    expect(await verifyMediaSignature(SECRET, "m-2", "slide-1.jpg", String(exp), "x", 0)).toBe(
      "invalid",
    );
    const sig = path.split("/")[4] ?? "";
    expect(
      await verifyMediaSignature(SECRET, "m-2", "slide-1.jpg", String(exp), sig, exp * 1000 - 1),
    ).toBe("ok");
    expect(
      await verifyMediaSignature(SECRET, "m-2", "slide-1.jpg", String(exp), sig, exp * 1000),
    ).toBe("expired");
  });

  it("stops serving media of cancelled orders and undeclared files", async () => {
    await setup();
    await createReadyOrder("m-3", [img(1)], [target("facebook.photo")]);
    const path = await signMediaPath(SECRET, "m-3", "slide-1.jpg", future());
    expect((await exports.default.fetch(`${BASE}${path}`)).status).toBe(200);
    const other = await signMediaPath(SECRET, "m-3", "nope.jpg", future());
    expect((await exports.default.fetch(`${BASE}${other}`)).status).toBe(404);
    await api("POST", "/v1/orders/m-3/cancel");
    expect((await exports.default.fetch(`${BASE}${path}`)).status).toBe(404);
  });
});

describe("unknown routes", () => {
  it("answers 404 with the error shape", async () => {
    expectError(await api("GET", "/nope"), 404, "not_found");
  });
});
