import { describe, expect, it } from "vitest";
import {
  classifyGraphError,
  encodeParamPairs,
  GraphClient,
  GraphError,
  type LogEvent,
  REDACTED,
  redact,
  retryAfterFromHeaders,
} from "../src/index.ts";
import { FakeClock } from "../src/testing/index.ts";
import { drive, requests, setup, USER_TOKEN } from "./helpers.ts";

const TOKEN = `EAAsecret${"Z".repeat(40)}`;

function scripted(responses: (Response | Error)[]) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("no more scripted responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, seen };
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
const err = (
  status: number,
  error: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function client(
  responses: (Response | Error)[],
  extra: ConstructorParameters<typeof GraphClient>[0] = {},
) {
  const clock = new FakeClock();
  const sleeps: number[] = [];
  const logs: LogEvent[] = [];
  const s = scripted(responses);
  const graph = new GraphClient({
    fetch: s.fetch,
    clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
    random: () => 0.5,
    logger: (e) => logs.push(e),
    ...extra,
  });
  return { graph, sleeps, logs, seen: s.seen, clock };
}

describe("encoding", () => {
  it("JSON-encodes nested values, drops undefined/null, keeps booleans and numbers", () => {
    expect(
      encodeParamPairs({
        caption: "a",
        skip: undefined,
        none: null,
        published: false,
        thumb_offset: 1500,
        children: ["1", "2"],
        trial_params: { graduation_strategy: "MANUAL", x: undefined },
      }),
    ).toEqual([
      ["caption", "a"],
      ["published", "false"],
      ["thumb_offset", "1500"],
      ["children", '["1","2"]'],
      ["trial_params", '{"graduation_strategy":"MANUAL"}'],
    ]);
  });

  it("indexed arrays use key[i]", () => {
    expect(
      encodeParamPairs({ attached_media: [{ media_fbid: "1" }, { media_fbid: "2" }] }, [
        "attached_media",
      ]),
    ).toEqual([
      ["attached_media[0]", '{"media_fbid":"1"}'],
      ["attached_media[1]", '{"media_fbid":"2"}'],
    ]);
  });

  it("builds versioned URLs and keeps the token out of them", async () => {
    const c = client([ok({ id: "1" })]);
    await c.graph.get("/123", { fields: "id" }, TOKEN);
    expect(c.seen[0]?.url).toBe("https://graph.facebook.com/v27.0/123?fields=id");
    expect(new Headers(c.seen[0]?.init?.headers).get("authorization")).toBe(`OAuth ${TOKEN}`);
  });

  it("adds appsecret_proof (HMAC-SHA256 of the token) when an app secret is configured", async () => {
    const c = client([ok({ id: "1" })], { appSecret: "app-secret" });
    await c.graph.get("/123", {}, "token-value");
    const proof = new URL(c.seen[0]?.url ?? "").searchParams.get("appsecret_proof");
    // HMAC-SHA256("app-secret", "token-value"), computed independently with WebCrypto.
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("app-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("token-value")),
    );
    expect(proof).toBe(Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join(""));
  });

  it("refuses to send a token to a non-Meta upload URL", async () => {
    const c = client([ok({})]);
    await expect(
      c.graph.request({
        method: "POST",
        path: "https://evil.example.com/upload",
        accessToken: TOKEN,
        idempotent: true,
      }),
    ).rejects.toThrow(/non-Meta/);
    expect(c.seen).toHaveLength(0);
  });
});

describe("error parsing", () => {
  it("parses code, subcode, is_transient, fbtrace_id, user message", async () => {
    const c = client([
      err(400, {
        message: "(#100) Invalid parameter",
        type: "OAuthException",
        code: 100,
        error_subcode: 2207009,
        is_transient: false,
        error_user_title: "Başlık",
        error_user_msg: "Mesaj",
        fbtrace_id: "Abc123",
      }),
    ]);
    const e = await c.graph.get("/1", {}, TOKEN).catch((x) => x);
    expect(e).toBeInstanceOf(GraphError);
    expect((e as GraphError).info).toMatchObject({
      httpStatus: 400,
      code: 100,
      subcode: 2207009,
      type: "OAuthException",
      isTransient: false,
      userTitle: "Başlık",
      userMessage: "Mesaj",
      fbtraceId: "Abc123",
      category: "media",
      request: "GET graph.facebook.com/v27.0/1",
    });
  });

  it("parses rupload debug_info failures", async () => {
    const c = client([
      new Response(
        JSON.stringify({
          debug_info: {
            retriable: false,
            type: "ProcessingFailedError",
            message: "Request processing failed",
          },
        }),
        {
          status: 400,
        },
      ),
    ]);
    const e = (await c.graph
      .request({
        method: "POST",
        host: "rupload",
        versioned: false,
        path: "/ig-api-upload/v27.0/1",
        idempotent: true,
      })
      .catch((x) => x)) as GraphError;
    expect(e.info).toMatchObject({
      type: "ProcessingFailedError",
      isTransient: false,
      httpStatus: 400,
    });
  });

  it.each([
    [{ code: 4 }, "rate_limit"],
    [{ code: 17 }, "rate_limit"],
    [{ code: 32 }, "rate_limit"],
    [{ code: 613 }, "rate_limit"],
    [{ code: 80001 }, "rate_limit"],
    [{ code: 80002 }, "rate_limit"],
    [{ code: 190, subcode: 463 }, "auth"],
    [{ code: 102 }, "auth"],
    [{ code: 10 }, "permission"],
    [{ code: 200 }, "permission"],
    [{ code: 9, subcode: 2207042 }, "publish_limit"],
    [{ code: 368 }, "spam_block"],
    [{ code: 506 }, "duplicate"],
    [{ code: 25, subcode: 2207050 }, "account_restricted"],
    [{ code: 9007, subcode: 2207027 }, "not_ready"],
    [{ code: -2, subcode: 2207020 }, "container_expired"],
    [{ code: -1, subcode: 2207001 }, "transient"],
    [{ code: 2 }, "transient"],
    [{ code: 100, isTransient: true }, "transient"],
    [{ code: 100 }, "invalid_request"],
  ] as const)("%j -> %s", (e, category) => {
    expect(
      classifyGraphError({
        httpStatus: 400,
        code: e.code,
        subcode: "subcode" in e ? e.subcode : null,
        isTransient: "isTransient" in e ? e.isTransient : false,
      }),
    ).toBe(category);
  });
});

describe("retry and backoff", () => {
  it("retries transient errors on idempotent calls with exponential backoff", async () => {
    const c = client([
      err(500, { code: 2, message: "Service temporarily unavailable", is_transient: true }),
      err(500, { code: 1, message: "An unknown error occurred" }),
      new TypeError("fetch failed"),
      ok({ id: "1" }),
    ]);
    await expect(c.graph.get("/1", {}, TOKEN)).resolves.toEqual({ id: "1" });
    // Equal jitter with random=0.5: 0.75 * base * 2^(n-1)
    expect(c.sleeps).toEqual([750, 1500, 3000]);
  });

  it("gives up after maxAttempts", async () => {
    const c = client(Array.from({ length: 4 }, () => err(503, { code: 2, message: "down" })));
    const e = (await c.graph.get("/1", {}, TOKEN).catch((x) => x)) as GraphError;
    expect(e.info.category).toBe("transient");
    expect(c.seen).toHaveLength(4);
  });

  it("never retries a non-idempotent call after an ambiguous failure", async () => {
    const c = client([err(500, { code: 2, message: "down" }), ok({ id: "1" })]);
    await expect(
      c.graph.request({
        method: "POST",
        path: "/1/media_publish",
        form: { creation_id: "9" },
        accessToken: TOKEN,
        idempotent: false,
      }),
    ).rejects.toBeInstanceOf(GraphError);
    expect(c.seen).toHaveLength(1);
    const c2 = client([new TypeError("socket hang up"), ok({ id: "1" })]);
    await expect(
      c2.graph.request({
        method: "POST",
        path: "/1/media_publish",
        accessToken: TOKEN,
        idempotent: false,
      }),
    ).rejects.toBeInstanceOf(GraphError);
    expect(c2.seen).toHaveLength(1);
  });

  it("does retry a non-idempotent call rejected by a rate limit (not executed)", async () => {
    const c = client([
      err(400, { code: 4, message: "(#4) Application request limit reached" }),
      ok({ id: "1" }),
    ]);
    await expect(
      c.graph.request({ method: "POST", path: "/1/media", accessToken: TOKEN, idempotent: false }),
    ).resolves.toMatchObject({ data: { id: "1" } });
    expect(c.sleeps).toEqual([750]);
  });

  it("honours estimated_time_to_regain_access and hands long waits back to the caller", async () => {
    const buc = JSON.stringify({
      "123": [{ type: "instagram", call_count: 100, estimated_time_to_regain_access: 12 }],
    });
    expect(retryAfterFromHeaders(new Headers({ "x-business-use-case-usage": buc }))).toBe(
      12 * 60_000,
    );
    const c = client([
      err(400, { code: 80002, message: "too many calls" }, { "x-business-use-case-usage": buc }),
    ]);
    const e = (await c.graph.get("/1", {}, TOKEN).catch((x) => x)) as GraphError;
    expect(e.info.category).toBe("rate_limit");
    expect(e.info.retryAfterMs).toBe(12 * 60_000);
    expect(c.sleeps).toEqual([]);
  });

  it("the state machine turns a long rate limit into a scheduled wait", async () => {
    const env = setup();
    env.fake.failNext("ig.media.create", {
      code: 80002,
      message: "There have been too many calls to this Instagram account.",
      headers: {
        "x-business-use-case-usage": JSON.stringify({
          x: [{ estimated_time_to_regain_access: 30 }],
        }),
      },
    });
    const { outcomes, out } = await drive(env, env.publisher.start(requests.igImage()), env.igCtx);
    const retry = outcomes.find((o) => o.status === "wait" && o.reason === "retry");
    expect(retry && retry.status === "wait" && retry.resumeAt - retry.state.updatedAt).toBe(
      30 * 60_000,
    );
    expect(out.status).toBe("done");
  });

  it("transient failures inside a step become scheduled retries, then succeed", async () => {
    const env = setup();
    env.fake.failNext(
      "ig.media_publish",
      { status: 500, code: 2, message: "Service temporarily unavailable", isTransient: true },
      1,
    );
    const { out, outcomes } = await drive(env, env.publisher.start(requests.igImage()), env.igCtx);
    expect(out.status).toBe("done");
    expect(outcomes.some((o) => o.status === "wait" && o.reason === "retry")).toBe(true);
  });

  it("stops automatic retries after maxStepRetries but keeps the phase", async () => {
    const env = setup({ publisher: { machine: { maxStepRetries: 2 }, retry: { maxAttempts: 1 } } });
    env.fake.failNext("ig.quota", { status: 500, code: 2, message: "down", isTransient: true }, 10);
    const { out, state } = await drive(env, env.publisher.start(requests.igImage()), env.igCtx);
    expect(out.status === "failed" && out.error).toMatchObject({
      code: "TRANSIENT",
      retryable: true,
      action: "retry",
    });
    expect(state.phase).toBe("check_quota");
  });
});

describe("token redaction", () => {
  it("redacts tokens, secrets and proofs from free text", () => {
    const text = `GET /me?access_token=${TOKEN}&appsecret_proof=abc123 Authorization: OAuth ${TOKEN} app 1234567890|abcdefghijklmnopqrstu "input_token":"xyz-secret-token" client_secret=s3cr3t`;
    const out = redact(text);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("abcdefghijklmnopqrstu");
    expect(out).not.toContain("xyz-secret-token");
    expect(out).not.toContain("s3cr3t");
    expect(out).toContain(REDACTED);
  });

  it("redacts a token Meta echoes back in an error message", async () => {
    const plain = "plain-token-without-meta-prefix";
    const c = client([
      err(400, { code: 190, message: `Invalid OAuth access token: ${plain}`, fbtrace_id: "T" }),
    ]);
    const e = (await c.graph.get("/1", {}, plain).catch((x) => x)) as GraphError;
    expect(e.message).not.toContain(plain);
    expect(JSON.stringify(e)).not.toContain(plain);
    expect(e.info.message).toContain(REDACTED);
  });

  it("redacts network error text and never logs tokens", async () => {
    const c = client([
      new TypeError(`connect failed for https://graph.facebook.com/x?access_token=${TOKEN}`),
    ]);
    const e = (await c.graph
      .request({ method: "POST", path: "/1/media", accessToken: TOKEN, idempotent: false })
      .catch((x) => x)) as GraphError;
    expect(JSON.stringify(e)).not.toContain(TOKEN);
    expect(String(e)).not.toContain(TOKEN);
    expect(JSON.stringify(c.logs)).not.toContain(TOKEN);
  });

  it("publish failures persisted in state contain no token", async () => {
    const env = setup();
    env.fake.failNext("ig.media.create", {
      code: 190,
      message: `Error validating access token ${USER_TOKEN}`,
    });
    const { out, state } = await drive(env, env.publisher.start(requests.igImage()), env.igCtx);
    expect(out.status).toBe("failed");
    expect(JSON.stringify(state)).not.toContain(USER_TOKEN);
    expect(JSON.stringify(out)).not.toContain(USER_TOKEN);
  });

  it("logs across a full publish never contain the token", async () => {
    const logs: LogEvent[] = [];
    const env = setup({ publisher: { logger: (e) => logs.push(e) } });
    await drive(env, env.publisher.start(requests.fbMultiPhoto()), env.fbCtx);
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toMatch(/EAA/);
  });
});
