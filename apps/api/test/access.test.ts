import { env, exports } from "cloudflare:workers";
import type { ApiErrorBody } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { isAllowedOrigin, isLoopbackHost } from "../src/middleware/access.ts";
import { BASE, LOCAL, OWNER_SECRET } from "./helpers.ts";

/*
 * G1: only the desktop app itself is the `local` principal. A web page open in a
 * browser on the Mac reaches 127.0.0.1 too, but it cannot know the owner secret, cannot
 * name a loopback Host after DNS rebinding, and carries its own Origin.
 */

async function call(url: string, init: RequestInit = {}) {
  const res = await exports.default.fetch(url, init);
  const text = await res.text();
  const body = res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
  return { status: res.status, body: body as ApiErrorBody };
}

const json = (value: unknown) => ({
  method: "POST",
  body: JSON.stringify(value),
});

describe("the Mac app's own requests (local principal)", () => {
  it("lets the app in with its owner secret, by any loopback name", async () => {
    for (const base of [BASE, "http://localhost:8790", "http://[::1]:8790"]) {
      expect((await call(`${base}/api/devices`, { headers: LOCAL })).status, base).toBe(200);
    }
  });

  it("refuses a loopback request without the owner secret or with a wrong one", async () => {
    const missing = await call(`${BASE}/api/devices`, {
      headers: { "CF-Connecting-IP": "127.0.0.1" },
    });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe("unauthorized");
    const wrong = await call(`${BASE}/api/devices`, {
      headers: { ...LOCAL, "X-Studio-Owner": `${OWNER_SECRET}x` },
    });
    expect(wrong.status).toBe(401);
  });

  it("refuses a DNS-rebound host even with the right secret", async () => {
    for (const host of ["http://evil.example:8790", "http://127.0.0.1.nip.io:8790"]) {
      expect((await call(`${host}/api/devices`, { headers: LOCAL })).status, host).toBe(401);
    }
  });

  it("refuses a POST from a web page's origin, even a text/plain one", async () => {
    const page = await call(`${BASE}/api/brands`, {
      ...json({ name: "x", slug: "evil-brand" }),
      headers: { ...LOCAL, Origin: "https://evil.example", "content-type": "text/plain" },
    });
    expect(page.status).toBe(401);
    // The same request without the secret (what a page can actually send) is refused too.
    const plain = await call(`${BASE}/api/pairing/codes`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "127.0.0.1", "content-type": "text/plain" },
      body: "{}",
    });
    expect(plain.status).toBe(401);
    const nullOrigin = await call(`${BASE}/api/pairing/codes`, {
      method: "POST",
      headers: { ...LOCAL, Origin: "null" },
    });
    expect(nullOrigin.status).toBe(401);
  });

  it("accepts the app's own origins (packaged and dev renderer)", async () => {
    for (const origin of ["studio://app", "http://127.0.0.1:5183", "http://localhost:5183"]) {
      const res = await call(`${BASE}/api/pairing/codes`, {
        method: "POST",
        headers: { ...LOCAL, Origin: origin },
      });
      expect(res.status, origin).toBe(201);
    }
  });

  it("refuses a WebSocket from a web page's origin or without the secret", async () => {
    const foreign = await exports.default.fetch(`${BASE}/api/jobs/stream`, {
      headers: { ...LOCAL, Upgrade: "websocket", Origin: "https://evil.example" },
    });
    expect(foreign.status).toBe(401);
    const noSecret = await exports.default.fetch(`${BASE}/api/jobs/stream`, {
      headers: { "CF-Connecting-IP": "127.0.0.1", Upgrade: "websocket" },
    });
    expect(noSecret.status).toBe(401);
    const app = await exports.default.fetch(`${BASE}/api/jobs/stream`, {
      headers: { ...LOCAL, Upgrade: "websocket", Origin: "studio://app" },
    });
    expect(app.status).toBe(101);
    app.webSocket?.accept();
    app.webSocket?.close(1000, "done");
  });

  it("never treats gatewayed traffic as the Mac, secret or not (device-only)", async () => {
    const viaGateway = { ...LOCAL, "X-Studio-Gateway": "1" };
    expect((await call(`${BASE}/api/devices`, { headers: viaGateway })).status).toBe(401);
    const worker = await call(`${BASE}/api/devices`, {
      headers: { ...viaGateway, Authorization: `Bearer ${env.WORKER_TOKEN}` },
    });
    expect(worker.status).toBe(403);
  });

  it("refuses a request whose peer is not loopback", async () => {
    const res = await call(`${BASE}/api/devices`, {
      headers: { ...LOCAL, "CF-Connecting-IP": "192.168.1.20" },
    });
    expect(res.status).toBe(401);
  });

  it("fails closed when the API has no owner secret configured", async () => {
    const res = await app.fetch(new Request(`${BASE}/api/devices`, { headers: LOCAL }), {
      ...env,
      STUDIO_OWNER_SECRET: "",
    } as Env);
    expect(res.status).toBe(401);
  });
});

describe("the worker token", () => {
  it("still works from loopback and through the gateway, without the owner secret", async () => {
    const auth = { Authorization: `Bearer ${env.WORKER_TOKEN}` };
    const loopback = await call(`${BASE}/api/brands`, {
      headers: { "CF-Connecting-IP": "127.0.0.1", ...auth },
    });
    expect(loopback.status).toBe(200);
    const lan = await call(`${BASE}/api/brands`, {
      headers: { "CF-Connecting-IP": "10.1.2.3", "X-Studio-Gateway": "1", ...auth },
    });
    expect(lan.status).toBe(200);
    // …but it is not the Mac: device management stays Mac-only.
    const devices = await call(`${BASE}/api/devices`, {
      headers: { "CF-Connecting-IP": "127.0.0.1", ...auth },
    });
    expect(devices.status).toBe(403);
  });
});

describe("helpers", () => {
  it("allows only the app's and loopback origins", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("studio://app")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5183")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:5183")).toBe(true);
    for (const bad of [
      "null",
      "",
      "https://evil.example",
      "http://127.0.0.1.evil.example",
      "studio://evil",
      "file://",
      "http://127.0.0.1:5183/path",
    ]) {
      expect(isAllowedOrigin(bad), bad).toBe(false);
    }
  });

  it("knows loopback hosts", () => {
    expect(isLoopbackHost("http://127.0.0.1:8790/api")).toBe(true);
    expect(isLoopbackHost("http://LOCALHOST:8790/api")).toBe(true);
    expect(isLoopbackHost("http://[::1]:8790/api")).toBe(true);
    expect(isLoopbackHost("http://192.168.1.2:8790/api")).toBe(false);
    expect(isLoopbackHost("http://localhost.evil.example/api")).toBe(false);
  });
});
