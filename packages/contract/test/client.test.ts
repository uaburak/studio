import { describe, expect, it } from "vitest";
import {
  ApiError,
  createApiClient,
  encodeJobStreamMessage,
  type HealthResponse,
  type JobStreamMessage,
} from "../src/index.ts";

const healthy: HealthResponse = {
  status: "ok",
  service: "studio-api",
  version: "0.0.0",
  time: "2026-11-16T10:00:00.000Z",
  checks: { db: "ok" },
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("api client", () => {
  it("returns a validated health response", async () => {
    const client = createApiClient({ fetch: fakeFetch(healthy) });
    await expect(client.health()).resolves.toEqual(healthy);
  });

  it("rejects a response that breaks the contract", async () => {
    const client = createApiClient({ fetch: fakeFetch({ status: "ok" }) });
    await expect(client.health()).rejects.toBeInstanceOf(ApiError);
  });

  it("surfaces HTTP errors", async () => {
    const client = createApiClient({ fetch: fakeFetch({}, 503) });
    await expect(client.health()).rejects.toMatchObject({ status: 503 });
  });
});

describe("api client: core resources", () => {
  const brand = {
    id: "b1",
    name: "Venta",
    slug: "venta",
    defaultLanguage: "tr",
    status: "active",
    createdAt: "2026-11-16T10:00:00.000Z",
    updatedAt: "2026-11-16T10:00:00.000Z",
  };

  function recordingFetch(body: unknown, status = 200) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it("sends JSON bodies and validates the response", async () => {
    const { calls, fetchImpl } = recordingFetch(brand, 201);
    const client = createApiClient({ baseUrl: "http://api.test/", fetch: fetchImpl });
    await expect(client.brands.create({ name: "Venta" })).resolves.toEqual(brand);
    expect(calls[0]?.url).toBe("http://api.test/api/brands");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: "Venta" });
  });

  it("builds query strings, skipping undefined values", async () => {
    const { calls, fetchImpl } = recordingFetch({ items: [brand], nextCursor: null });
    const client = createApiClient({ fetch: fetchImpl });
    const page = await client.brands.list({ limit: 5, status: undefined, cursor: "c1" });
    expect(page.items).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/brands?limit=5&cursor=c1");
  });

  it("surfaces the contract error code and issues", async () => {
    const { fetchImpl } = recordingFetch(
      { error: { code: "hash_mismatch", message: "stale", issues: [] } },
      409,
    );
    const client = createApiClient({ fetch: fetchImpl });
    const err = await client.contents.approve("c1", "a".repeat(64)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "hash_mismatch" });
  });

  it("approves with the hash alone, or acknowledging the checks (E7)", async () => {
    const hash = "a".repeat(64);
    const { calls, fetchImpl } = recordingFetch({});
    const client = createApiClient({ fetch: fetchImpl });
    await client.contents.approve("c1", hash).catch(() => {});
    await client.contents.approve("c1", { hash, acknowledgeChecks: true }).catch(() => {});
    expect(calls.map((c) => [c.url, c.init?.method, JSON.parse(String(c.init?.body))])).toEqual([
      ["/api/contents/c1/approve", "POST", { hash }],
      ["/api/contents/c1/approve", "POST", { hash, acknowledgeChecks: true }],
    ]);
  });

  it("handles 204 deletes and multipart uploads", async () => {
    const del = recordingFetch(null, 204);
    await expect(
      createApiClient({ fetch: del.fetchImpl }).contents.delete("c1"),
    ).resolves.toBeUndefined();
    expect(del.calls[0]?.init?.method).toBe("DELETE");

    const asset = {
      id: "a1",
      brandId: "b1",
      kind: "image",
      source: "upload",
      objectKey: "brands/b1/assets/a1.png",
      mimeType: "image/png",
      bytes: 3,
      sha256: "0".repeat(64),
      width: null,
      height: null,
      durationMs: null,
      originalFilename: "x.png",
      createdAt: "2026-11-16T10:00:00.000Z",
    };
    const up = recordingFetch(asset, 201);
    const client = createApiClient({ fetch: up.fetchImpl });
    await client.assets.upload({
      brandId: "b1",
      width: 10,
      file: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      filename: "x.png",
    });
    const form = up.calls[0]?.init?.body as FormData;
    expect(form.get("brandId")).toBe("b1");
    expect(form.get("width")).toBe("10");
    expect((form.get("file") as File).name).toBe("x.png");
    expect(client.assets.contentUrl("a 1")).toBe("/api/assets/a%201/content");
  });
});

describe("api client: jobs live (F1-6)", () => {
  const now = "2026-11-16T10:00:00.000Z";
  const job = {
    id: "j1",
    type: "demo.echo",
    status: "running",
    payload: {},
    createdAt: now,
    updatedAt: now,
    cancelRequestedAt: now,
  };

  it("cancels a job and reads presence", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(input)}`);
      const body = String(input).endsWith("/presence")
        ? { online: false, lastSeenAt: null, workers: [], currentJobs: [], queueLength: 3 }
        : job;
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const client = createApiClient({ baseUrl: "http://api.test", fetch: fetchImpl });
    await expect(client.jobs.cancel("j1")).resolves.toMatchObject({ cancelRequestedAt: now });
    await expect(client.workers.presence()).resolves.toMatchObject({ queueLength: 3 });
    expect(calls).toEqual([
      "POST http://api.test/api/jobs/j1/cancel",
      "GET http://api.test/api/workers/presence",
    ]);
  });

  it("builds stream URLs", () => {
    expect(createApiClient({ baseUrl: "https://s.example" }).jobs.streamUrl({ jobId: "a b" })).toBe(
      "wss://s.example/api/jobs/stream?jobId=a+b",
    );
    expect(createApiClient({ baseUrl: "http://127.0.0.1:8787" }).jobs.streamUrl()).toBe(
      "ws://127.0.0.1:8787/api/jobs/stream",
    );
    expect(createApiClient().jobs.streamUrl({ brandId: "b1" })).toBe("/api/jobs/stream?brandId=b1");
  });

  it("watches the stream, decodes frames and reconnects after a drop", async () => {
    const sockets: FakeWs[] = [];
    class FakeWs extends EventTarget {
      constructor(readonly url: string) {
        super();
        sockets.push(this);
      }
      closedByClient = false;
      close() {
        this.closedByClient = true;
        this.dispatchEvent(new Event("close"));
      }
      emit(frame: JobStreamMessage | string) {
        const data = typeof frame === "string" ? frame : encodeJobStreamMessage(frame);
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }
    const client = createApiClient({
      baseUrl: "http://api.test",
      WebSocket: FakeWs as unknown as typeof WebSocket,
    });
    const got: string[] = [];
    const statuses: string[] = [];
    const watch = client.jobs.watch(
      { jobId: "j1" },
      { onMessage: (m) => got.push(m.type), onStatus: (s) => statuses.push(s) },
      { reconnectDelayMs: 5 },
    );
    expect(sockets[0]?.url).toBe("ws://api.test/api/jobs/stream?jobId=j1");
    sockets[0]?.dispatchEvent(new Event("open"));
    sockets[0]?.emit({ type: "pong", ts: 1 });
    sockets[0]?.emit("{garbage");
    sockets[0]?.dispatchEvent(new Event("close")); // server dropped us
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets).toHaveLength(2);
    watch.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets).toHaveLength(2);
    expect(sockets[1]?.closedByClient).toBe(true);
    expect(got).toEqual(["pong"]);
    expect(statuses).toEqual(["connecting", "open", "closed", "connecting", "closed"]);
  });
});
