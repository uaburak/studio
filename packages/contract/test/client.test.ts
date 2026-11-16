import { describe, expect, it } from "vitest";
import { ApiError, createApiClient, type HealthResponse } from "../src/index.ts";

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
